'use strict';
// NDJSON client for `zcode.cjs app-server --stdio` (DESIGN §9) plus the
// one-turn orchestration shared by `run` and `agent`.
//
// Wire facts (live-probed against engine v0.16.9; see DESIGN §9):
//  - one JSON object per line, both directions; our request ids are numbers,
//    server-directed request ids are strings ("server-2"); answers repeat
//    THEIR id. A "jsonrpc" key must NOT be sent.
//  - session/create result: result.session.{sessionId, mode, model, …}
//    (mode param in create is NOT honored — session/setMode is required).
//  - completion: session/event with params.type "turn.completed"
//    (payload.response is the authoritative final text, payload.usage the
//    usage); computer-use/operation-event kind "turn-completed" and
//    v4/telemetry/event kind "turn.terminal" corroborate.
//  - engine-reported model evidence: session/event params.type
//    "session.updated" with payload.type "model_request_started"
//    ({providerId, modelId, modelCall.reasoning.requestedLevel}).
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const crypto = require('node:crypto');
const fs = require('node:fs');

const RUNTIME_PREFERENCES = {
  nativeSearchEnhancementsEnabled: false,
  memoryEnabled: false,
  askUserQuestionAutoResolutionEnabled: true,
  modelContextBudgetStrategy: 'preflight-v1',
};

class TurnError extends Error {
  constructor(message, { kind = 'turn_failed' } = {}) {
    super(message);
    this.kind = kind;
  }
}

class AppServerClient {
  constructor({ nodeBin, enginePath, env, cwd, scrub = (s) => s }) {
    this.nodeBin = nodeBin;
    this.enginePath = enginePath;
    this.env = env;
    this.cwd = cwd;
    this.scrub = scrub;
    this.child = null;
    this.nextId = 1;
    this.pending = new Map();
    this.onFrame = null; // (frame) => void for every notification
    this.dead = false;
    this.engineStderr = '';
  }

  start() {
    this.child = spawn(this.nodeBin, [this.enginePath, 'app-server', '--stdio'], {
      env: this.env,
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stderr.on('data', (d) => {
      this.engineStderr += d;
      if (this.engineStderr.length > 20000) {
        this.engineStderr = this.engineStderr.slice(-20000);
      }
    });
    this.child.on('exit', (code, signal) => {
      this.dead = true;
      const err = new Error(
        `engine app-server exited (code=${code} signal=${signal})` +
          (this.engineStderr ? `\nengine stderr tail: ${this.engineStderr.split('\n').slice(-8).join('\n')}` : '')
      );
      for (const { reject } of this.pending.values()) reject(err);
      this.pending.clear();
      if (this.onExit) this.onExit(err);
    });
    const rl = readline.createInterface({ input: this.child.stdout });
    rl.on('line', (line) => this._handleLine(line));
    return this;
  }

  _handleLine(line) {
    if (!line.trim()) return;
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      return; // engine chatter we do not speak
    }
    if (frame && frame.method !== undefined && frame.id !== undefined) {
      this._handleServerRequest(frame);
      return;
    }
    if (frame && frame.id !== undefined && (frame.result !== undefined || frame.error !== undefined)) {
      const p = this.pending.get(frame.id);
      if (p) {
        this.pending.delete(frame.id);
        clearTimeout(p.timer);
        if (frame.error) p.reject(new Error(`engine error on ${p.method}: ${JSON.stringify(frame.error)}`));
        else p.resolve(frame.result);
      }
      return;
    }
    if (this.onFrame) this.onFrame(frame);
  }

  // Per-method policy table for server-directed requests (DESIGN §9).
  _handleServerRequest(frame) {
    const method = frame.method;
    const id = frame.id;
    const reply = (payload) =>
      this.child.stdin.write(JSON.stringify({ id, result: payload }) + '\n');
    const replyError = (code, message) =>
      this.child.stdin.write(JSON.stringify({ id, error: { code, message } }) + '\n');

    if (method === 'session/requestRuntimePreferences') {
      reply(RUNTIME_PREFERENCES);
      return;
    }
    if (method === 'interaction/requestPermission') {
      // Allow-schema pinned from the engine bundle's own headless broker:
      // {decision:"allow", reason, resolvedAt}.
      reply({
        decision: 'allow',
        reason: 'zai-code: headless auto-approve (yolo mode; --cwd is the blast radius)',
        resolvedAt: new Date().toISOString(),
      });
      return;
    }
    if (method === 'interaction/requestUserInput') {
      replyError(-32000, 'zai-code: headless run requested user input');
      if (this.onUserInputRequest) this.onUserInputRequest(frame);
      return;
    }
    // Everything else — incl. interaction/requestOfficialMcpAuthHeaders,
    // proven non-fatal with -32601 — gets method-not-found and the run
    // continues.
    replyError(-32601, `zai-code: no policy for server request ${method}`);
    if (this.onServerRequest) this.onServerRequest(frame);
  }

  request(method, params, { timeoutMs = 30000 } = {}) {
    if (this.dead) return Promise.reject(new Error('engine app-server is dead'));
    const id = this.nextId++;
    this.child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout (${timeoutMs}ms) waiting for ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, method, timer });
    });
  }

  kill() {
    if (this.child && !this.dead) {
      try {
        this.child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }
  }
}

// --- turn orchestration -----------------------------------------------------

function workspaceKeyFor(workspacePath) {
  // Deterministic; engine echoes it verbatim (semantics opaque, accepted
  // live). sha256-of-realpath per DESIGN §9 risk R2.
  const real = fs.realpathSync(workspacePath);
  return crypto.createHash('sha256').update(real).digest('hex').slice(0, 16);
}

// MCP connections are asynchronous (stdio servers must be spawned) and —
// live-probed — only mcp/list mode:"connect" actually STARTS them;
// mode:"status" merely observes. Force the connection, then poll until
// every explicitly-added server settles (connected/failed/…), so the first
// turn always sees the caller's --mcp servers. Inherited servers are
// best-effort and never block the send.
async function waitForMcp(client, { workspacePath, required, timeoutMs = 20000, onEvent = () => {} }) {
  if (!required || required.length === 0) return;
  const ws = { workspace: { workspacePath, workspaceKey: workspaceKeyFor(workspacePath) } };
  try {
    await client.request('mcp/list', { ...ws, mode: 'connect' }, { timeoutMs: 15000 });
  } catch {
    /* best-effort trigger; the status loop below still reports */
  }
  const deadline = Date.now() + timeoutMs;
  const settled = new Set();
  while (Date.now() < deadline && settled.size < required.length) {
    let statuses = {};
    try {
      const res = await client.request('mcp/list', { ...ws, mode: 'status' }, { timeoutMs: 5000 });
      statuses = (res && res.statuses) || {};
    } catch {
      /* transient — retry */
    }
    for (const name of required) {
      if (settled.has(name)) continue;
      const entry = statuses[name];
      const status = entry && entry.status;
      if (status === 'connected' || status === 'failed' || status === 'disabled' || status === 'untrusted') {
        settled.add(name);
        onEvent({
          type: 'mcp',
          name,
          status,
          toolCount: (entry && entry.toolCount) ?? null,
          failureKind: (entry && entry.failureKind) ?? null,
          error: (entry && entry.error) ? String(typeof entry.error === 'string' ? entry.error : JSON.stringify(entry.error)).slice(0, 300) : null,
        });
      }
    }
    if (settled.size < required.length) {
      await new Promise((r) => setTimeout(r, 750));
    }
  }
  for (const name of required) {
    if (!settled.has(name)) {
      onEvent({ type: 'mcp', name, status: 'timeout', toolCount: null });
    }
  }
}

// Runs one full turn: create (+setMode ladder) or resume → subscribe → send
// → wait for terminal. Resolves a turn result object; rejects with TurnError
// on failure. `resumeSessionId` continues a persisted session (the engine
// stores sessions in SQLite under the scratch HOME, so a new engine process
// picks up where the previous CLI invocation stopped).
async function executeTurn(client, {
  workspacePath,
  modelId,
  effort,
  prompt,
  timeoutMs,
  resumeSessionId = null,
  requiredMcp = [],
  onEvent = () => {},
}) {
  const started = Date.now();
  const turn = {
    sessionId: null,
    resumed: false,
    mode: null,
    response: '',
    usage: null,
    engineModel: null,
    engineProvider: null,
    engineReasoningLevel: null,
    terminalStatus: null,
    streamingEvents: 0,
    reasoningText: '',
    toolCallCount: null,
    toolEvents: 0,
    userInputFailure: null,
  };

  const deadline = started + timeoutMs;
  let completed = null; // {payload} from turn.completed
  let failed = null;
  let completer = null;
  const completion = new Promise((resolve) => { completer = resolve; });

  client.onUserInputRequest = (frame) => {
    turn.userInputFailure = frame;
    failed = new TurnError(
      'headless run requested user input: ' + client.scrub(JSON.stringify(frame.params || {}).slice(0, 800)),
      { kind: 'user_input' }
    );
    completer();
  };

  client.onFrame = (frame) => {
    const method = frame.method;
    const params = frame.params || {};
    if (method === 'session/event') {
      const type = params.type;
      if (type === 'model.streaming' && params.payload) {
        turn.streamingEvents++;
        if (params.payload.kind === 'reasoning_delta' && typeof params.payload.delta === 'string') {
          turn.reasoningText += params.payload.delta;
        }
        onEvent({ type: 'stream', kind: params.payload.kind, delta: params.payload.delta });
      } else if (type === 'tool.updated' && params.payload) {
        // Engine tool lifecycle: scheduled|started|progress|result|error|…
        turn.toolEvents++;
        onEvent({
          type: 'tool',
          phase: params.payload.kind ?? null,
          name: params.payload.toolName ?? null,
          id: params.payload.toolCallId ?? null,
        });
      } else if (type === 'turn.completed' && params.payload) {
        completed = params.payload;
        turn.response = typeof params.payload.response === 'string' ? params.payload.response : turn.response;
        turn.usage = params.payload.usage || turn.usage;
        if (typeof params.payload.toolCallCount === 'number') {
          turn.toolCallCount = params.payload.toolCallCount;
        }
        completer();
      } else if (type === 'turn.started') {
        onEvent({ type: 'turn', phase: 'started', turnId: params.turnId });
      } else if (type === 'session.updated' && params.payload && params.payload.type === 'model_request_started') {
        turn.engineProvider = params.payload.providerId ?? turn.engineProvider;
        turn.engineModel = params.payload.modelId ?? turn.engineModel;
        turn.engineReasoningLevel =
          params.payload.modelCall?.reasoning?.requestedLevel ?? turn.engineReasoningLevel;
        onEvent({
          type: 'model_request_started',
          providerId: params.payload.providerId,
          modelId: params.payload.modelId,
          reasoningLevel: params.payload.modelCall?.reasoning?.requestedLevel ?? null,
        });
      }
    } else if (method === 'state.updated') {
      const patch = params.patch || {};
      if (patch.mode && patch.mode.current) {
        turn.mode = patch.mode.current;
        onEvent({ type: 'state', mode: patch.mode.current });
      }
    } else if (method === 'v4/telemetry/event' && params.kind === 'turn.terminal') {
      turn.terminalStatus = params.status ?? turn.terminalStatus;
      if (params.status === 'failed') {
        failed = new TurnError(
          `turn.terminal failed: ${client.scrub(JSON.stringify(params.result || params).slice(0, 800))}`,
          { kind: 'terminal_failed' }
        );
        completer();
      }
    }
  };

  try {
    if (resumeSessionId) {
      // Continue a persisted session from a previous CLI invocation.
      const resumed = await client.request(
        'session/resume',
        { sessionId: resumeSessionId, thoughtLevel: effort },
        { timeoutMs: 30000 }
      );
      const session = resumed.session || resumed.value || {};
      turn.sessionId = session.sessionId || resumeSessionId;
      turn.resumed = true;
      turn.mode = session.mode || null;
      await client.request(
        'session/setMode',
        { sessionId: turn.sessionId, mode: 'yolo' },
        { timeoutMs: 15000 }
      );
      turn.mode = 'yolo';
    } else {
      const created = await client.request(
        'session/create',
        {
          workspace: { workspacePath, workspaceKey: workspaceKeyFor(workspacePath) },
          mode: 'yolo',
          model: {
            providerId: 'zai-api',
            modelId,
            options: { reasoningLevel: effort },
          },
          thoughtLevel: effort,
        },
        { timeoutMs: 30000 }
      );
      const session = created.session || created.value || {};
      turn.sessionId = session.sessionId;
      turn.mode = session.mode || null;
      if (!turn.sessionId) throw new TurnError('session/create returned no session.sessionId');

      // §9.1 mode ladder: create's mode param is not honored (live-probed);
      // force yolo and record it.
      if (session.mode !== 'yolo') {
        await client.request('session/setMode', { sessionId: turn.sessionId, mode: 'yolo' }, { timeoutMs: 15000 });
        turn.mode = 'yolo';
      }
    }

    await client.request(
      'session/subscribe',
      { sessionId: turn.sessionId, deliveryKind: 'desktop-continuous' },
      { timeoutMs: 15000 }
    );
    await waitForMcp(client, { workspacePath, required: requiredMcp, onEvent });
    await client.request(
      'session/send',
      {
        sessionId: turn.sessionId,
        content: prompt,
        modelSelection: {
          providerId: 'zai-api',
          modelId,
          options: { reasoningLevel: effort },
        },
      },
      { timeoutMs: 30000 }
    );

    const wait = setInterval(() => {
      if (Date.now() > deadline && !completed && !failed) {
        failed = new TurnError(`run exceeded --timeout-ms ${timeoutMs}`, { kind: 'timeout' });
        completer();
      }
    }, 500);
    try {
      await completion;
    } finally {
      clearInterval(wait);
    }

    if (failed) throw failed;
    if (!completed) throw new TurnError('turn ended without a completion event', { kind: 'no_completion' });
    if (completed.resultType && completed.resultType !== 'success') {
      throw new TurnError(`turn completed with resultType "${completed.resultType}"`, { kind: 'result_type' });
    }
    turn.durationMs = Date.now() - started;
    return turn;
  } finally {
    client.onFrame = null;
    client.onUserInputRequest = null;
  }
}

module.exports = {
  AppServerClient,
  executeTurn,
  TurnError,
  workspaceKeyFor,
  waitForMcp,
  RUNTIME_PREFERENCES,
};

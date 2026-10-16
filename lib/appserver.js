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
    // Own process group, so kill() takes the engine's tool subprocesses and
    // stdio MCP servers with it (a runaway shell command must not keep
    // writing to the workspace after cancel/timeout).
    this.child = spawn(this.nodeBin, [this.enginePath, 'app-server', '--stdio'], {
      env: this.env,
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });
    this.child.stderr.on('data', (d) => {
      this.engineStderr += d;
      if (this.engineStderr.length > 20000) {
        this.engineStderr = this.engineStderr.slice(-20000);
      }
    });
    // EPIPE on a dying engine and spawn failures (bad ZAI_CODE_NODE) must
    // surface as a failed request, never as an uncaught 'error' event.
    this.child.stdin.on('error', () => {});
    this.child.on('error', (err) => {
      if (this.dead) return;
      this.dead = true;
      const wrapped = new Error(`engine app-server failed to start: ${err.message}`);
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(wrapped);
      }
      this.pending.clear();
      if (this.onExit) this.onExit(wrapped);
    });
    this.child.on('exit', (code, signal) => {
      this.dead = true;
      const err = new Error(
        `engine app-server exited (code=${code} signal=${signal})` +
          (this.engineStderr ? `\nengine stderr tail: ${this.engineStderr.split('\n').slice(-8).join('\n')}` : '')
      );
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(err);
      }
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
        reason: 'zcode: headless auto-approve (yolo mode; --cwd is the blast radius)',
        resolvedAt: new Date().toISOString(),
      });
      return;
    }
    if (method === 'interaction/requestUserInput') {
      replyError(-32000, 'zcode: headless run requested user input');
      if (this.onUserInputRequest) this.onUserInputRequest(frame);
      return;
    }
    if (method === 'interaction/browserList') {
      // The desktop app answers with its built-in browser panes; the CLI has
      // none. An empty list lets the agent fall back to the user's own tools
      // (Playwright, MCP browsers) instead of failing on a policy error.
      reply({ browsers: [] });
      return;
    }
    if (method === 'interaction/browserExecute') {
      replyError(-32000, 'zcode: no built-in browser in the CLI; use Playwright or a browser MCP server');
      return;
    }
    // Everything else — incl. interaction/requestOfficialMcpAuthHeaders,
    // proven non-fatal with -32601 — gets method-not-found and the run
    // continues.
    replyError(-32601, `zcode: no policy for server request ${method}`);
    if (this.onServerRequest) this.onServerRequest(frame);
  }

  request(method, params, { timeoutMs = 30000 } = {}) {
    if (this.dead) return Promise.reject(new Error('engine app-server is dead'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.child.stdin.write(JSON.stringify({ id, method, params }) + '\n', (err) => {
        if (err && this.pending.has(id)) {
          clearTimeout(this.pending.get(id).timer);
          this.pending.delete(id);
          reject(new Error(`engine stdin closed while sending ${method}`));
        }
      });
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout (${timeoutMs}ms) waiting for ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, method, timer });
    });
  }

  // Asks the engine to abort the active prompt (session/stop). Best-effort
  // and bounded: a wedged engine must not block cancellation.
  async stopSession(sessionId, { timeoutMs = 3000 } = {}) {
    if (this.dead || !sessionId) return false;
    try {
      await this.request('session/stop', { sessionId }, { timeoutMs });
      return true;
    } catch {
      return false;
    }
  }

  kill() {
    if (!this.child || !this.child.pid) return;
    try {
      process.kill(-this.child.pid, 'SIGKILL'); // the whole engine group
    } catch {
      if (!this.dead) {
        try {
          this.child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
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
  const ws = { workspace: { workspacePath, workspaceKey: workspaceKeyFor(workspacePath) } };
  if (!required || required.length === 0) {
    // Still start inherited servers (the browser server); never block on them.
    client.request('mcp/list', { ...ws, mode: 'connect' }, { timeoutMs: 15000 }).catch(() => {});
    return;
  }
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

// Opens the engine session for an invocation: create (+setMode ladder) or
// resume a persisted one, subscribe, and wait for explicit MCP servers.
// Everything here is side-effect free on the workspace, so a failure in
// this phase is safe to retry with a fresh engine.
async function openSession(client, {
  workspacePath,
  modelId,
  effort,
  resumeSessionId = null,
  requiredMcp = [],
  onEvent = () => {},
}) {
  const session = { sessionId: null, resumed: false, mode: null };
  if (resumeSessionId) {
    const resumed = await client.request(
      'session/resume',
      { sessionId: resumeSessionId, thoughtLevel: effort },
      { timeoutMs: 30000 }
    );
    const s = resumed.session || resumed.value || {};
    session.sessionId = s.sessionId || resumeSessionId;
    session.resumed = true;
    session.mode = s.mode || null;
    await client.request('session/setMode', { sessionId: session.sessionId, mode: 'yolo' }, { timeoutMs: 15000 });
    session.mode = 'yolo';
  } else {
    const created = await client.request(
      'session/create',
      {
        workspace: { workspacePath, workspaceKey: workspaceKeyFor(workspacePath) },
        mode: 'yolo',
        model: { providerId: 'zai-api', modelId, options: { reasoningLevel: effort } },
        thoughtLevel: effort,
        // Persist the session row NOW: the default (deferred) loses it to
        // our SIGKILL on exit, and resume then 404s (-32004).
        persistence: 'immediate',
      },
      { timeoutMs: 30000 }
    );
    const s = created.session || created.value || {};
    session.sessionId = s.sessionId;
    session.mode = s.mode || null;
    if (!session.sessionId) throw new TurnError('session/create returned no session.sessionId');
    // §9.1 mode ladder: create's mode param is not honored (live-probed).
    if (s.mode !== 'yolo') {
      await client.request('session/setMode', { sessionId: session.sessionId, mode: 'yolo' }, { timeoutMs: 15000 });
      session.mode = 'yolo';
    }
  }
  await client.request(
    'session/subscribe',
    { sessionId: session.sessionId, deliveryKind: 'desktop-continuous' },
    { timeoutMs: 15000 }
  );
  await waitForMcp(client, { workspacePath, required: requiredMcp, onEvent });
  return session;
}

// Sends one prompt into an open session and waits for its terminal event.
// Resolves the turn facts; rejects with TurnError (kind: timeout |
// cancelled | user_input | terminal_failed | result_type | no_completion).
// On timeout or abort the engine is told to stop the active prompt
// (session/stop) before we give up on it, so no tool keeps running behind
// our back while the caller tears the engine down.
async function runTurn(client, session, {
  modelId,
  effort,
  prompt,
  deadline,
  signal = null,
  keepReasoning = false,
  onEvent = () => {},
}) {
  const started = Date.now();
  const turn = {
    response: '',
    usage: null,
    engineModel: null,
    engineProvider: null,
    engineReasoningLevel: null,
    terminalStatus: null,
    streamingEvents: 0,
    reasoningChars: 0,
    reasoningText: '',
    toolCallCount: null,
    toolEvents: 0,
    modelRequests: 0,
    userInput: null,
    durationMs: 0,
  };

  let completed = null;
  let failed = null;
  let completer = null;
  const completion = new Promise((resolve) => { completer = resolve; });
  const fail = (err) => {
    if (!failed && !completed) failed = err;
    completer();
  };

  client.onUserInputRequest = (frame) => {
    const params = frame.params || {};
    const question = client.scrub(
      String(params.message || params.prompt || params.question || JSON.stringify(params)).slice(0, 800)
    );
    turn.userInput = question;
    fail(new TurnError(`headless run requested user input: ${question}`, { kind: 'user_input' }));
  };

  client.onFrame = (frame) => {
    const method = frame.method;
    const params = frame.params || {};
    if (method === 'session/event') {
      const type = params.type;
      const payload = params.payload;
      if (type === 'model.streaming' && payload) {
        turn.streamingEvents++;
        if (payload.kind === 'reasoning_delta' && typeof payload.delta === 'string') {
          turn.reasoningChars += payload.delta.length;
          if (keepReasoning) turn.reasoningText += payload.delta;
        }
        onEvent({ type: 'stream', kind: payload.kind, delta: payload.delta });
      } else if (type === 'tool.updated' && payload) {
        // Engine tool lifecycle: scheduled|started|progress|result|error|…
        turn.toolEvents++;
        onEvent({
          type: 'tool',
          phase: payload.kind ?? null,
          name: payload.toolName ?? null,
          id: payload.toolCallId ?? null,
        });
      } else if (type === 'turn.completed' && payload) {
        completed = payload;
        turn.response = typeof payload.response === 'string' ? payload.response : turn.response;
        turn.usage = payload.usage || turn.usage;
        if (typeof payload.toolCallCount === 'number') turn.toolCallCount = payload.toolCallCount;
        completer();
      } else if (type === 'turn.started') {
        onEvent({ type: 'turn', phase: 'started', turnId: params.turnId });
      } else if (type === 'session.updated' && payload && payload.type === 'model_request_started') {
        turn.modelRequests++;
        turn.engineProvider = payload.providerId ?? turn.engineProvider;
        turn.engineModel = payload.modelId ?? turn.engineModel;
        turn.engineReasoningLevel = payload.modelCall?.reasoning?.requestedLevel ?? turn.engineReasoningLevel;
        onEvent({
          type: 'model_request_started',
          providerId: payload.providerId,
          modelId: payload.modelId,
          reasoningLevel: payload.modelCall?.reasoning?.requestedLevel ?? null,
        });
      }
    } else if (method === 'state.updated') {
      const patch = params.patch || {};
      if (patch.mode && patch.mode.current) onEvent({ type: 'state', mode: patch.mode.current });
    } else if (method === 'v4/telemetry/event' && params.kind === 'turn.terminal') {
      turn.terminalStatus = params.status ?? turn.terminalStatus;
      if (params.status === 'failed') {
        fail(new TurnError(
          `turn.terminal failed: ${client.scrub(JSON.stringify(params.result || params).slice(0, 800))}`,
          { kind: 'terminal_failed' }
        ));
      }
    }
  };
  const prevOnExit = client.onExit;
  client.onExit = (err) => fail(new TurnError(client.scrub(err.message), { kind: 'engine_exit' }));

  const remaining = Math.max(0, deadline - Date.now());
  const timer = setTimeout(
    () => fail(new TurnError('run exceeded --timeout-ms', { kind: 'timeout' })),
    remaining
  );
  const onAbort = () => fail(new TurnError('cancelled', { kind: 'cancelled' }));
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    if (!failed) {
      await Promise.race([
        client.request(
          'session/send',
          {
            sessionId: session.sessionId,
            content: prompt,
            modelSelection: { providerId: 'zai-api', modelId, options: { reasoningLevel: effort } },
          },
          { timeoutMs: 30000 }
        ),
        completion,
      ]);
    }
    await completion;
    if (failed) {
      if (['timeout', 'cancelled', 'user_input'].includes(failed.kind)) {
        await client.stopSession(session.sessionId);
      }
      // The partial facts (model requests so far) survive a failed turn.
      turn.durationMs = Date.now() - started;
      failed.turn = turn;
      throw failed;
    }
    if (completed.resultType && completed.resultType !== 'success') {
      throw new TurnError(`turn completed with resultType "${completed.resultType}"`, { kind: 'result_type' });
    }
    turn.durationMs = Date.now() - started;
    return turn;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
    client.onFrame = null;
    client.onUserInputRequest = null;
    client.onExit = prevOnExit;
  }
}

module.exports = {
  AppServerClient,
  openSession,
  runTurn,
  TurnError,
  workspaceKeyFor,
  waitForMcp,
  RUNTIME_PREFERENCES,
};

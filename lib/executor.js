'use strict';
// One invocation, start to handback. Every command that talks to the
// engine (run, task, agent, resume, detached workers) goes through
// execute(), so lifecycle, isolation, cancellation and the result shape are
// identical across them.
//
//   record → capacity → lease → engine HOME → snapshot → open session
//   → turn → [task: handback, checks, bounded repair turns] → subagents
//   → diff → status → result.json + final record
//
// Side-effect discipline: only the session-open phase is retried (it never
// touches the workspace). A prompt that reached the engine is never re-sent
// automatically; continuing is an explicit `zcode resume`, which tells the
// model the earlier work is already applied.
const fs = require('node:fs');
const path = require('node:path');
const store = require('./store.js');
const { resolveRuntime, makeClient } = require('./bootstrap.js');
const { buildEngineHome, rootDir, liveDir } = require('./isolation.js');
const { openSession, runTurn, TurnError } = require('./appserver.js');
const { runChecks } = require('./checks.js');
const {
  workspaceRoot,
  isOwned,
  acquireLease,
  liveLeases,
  snapshot,
  diffSnapshots,
} = require('./workspace.js');
const {
  buildTaskPrompt,
  buildRepairPrompt,
  buildResumePrompt,
  HANDBACK_REQUEST,
  parseHandback,
  deriveStatus,
} = require('./contract.js');

const RESULT_SCHEMA = 'zcode.result/1';
const SUBAGENT_TOOLS = new Set(['Agent', 'Task']);

class ExecError extends Error {
  constructor(message, { exitCode, kind }) {
    super(message);
    this.exitCode = exitCode;
    this.kind = kind;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Settings a session keeps across invocations (stored as invocation.json).
const SETTING_KEYS = [
  'kind', 'label', 'cwd', 'model', 'effort', 'timeoutMs', 'maxRepairs', 'checkTimeoutMs',
  'checks', 'owns', 'ownsDisplay', 'acceptanceDeclared', 'mcpSpecs', 'mcpInherit',
  'skillsDirs', 'noSkills', 'profile', 'includeReasoning', 'allowOverlap', 'stream',
];

function settingsOf(inv) {
  const out = {};
  for (const k of SETTING_KEYS) if (inv[k] !== undefined) out[k] = inv[k];
  return out;
}

function readSettings(id, env) {
  try {
    return JSON.parse(fs.readFileSync(path.join(store.sessionDir(id, env), 'invocation.json'), 'utf8'));
  } catch {
    return null;
  }
}

function writeSettings(id, inv, env) {
  store.writeJsonAtomic(path.join(store.sessionDir(id, env), 'invocation.json'), settingsOf(inv));
}

// Joins session/subagents with the per-session agents dir
// (<home>/.zcode/cli/agents/<parent>/agent_<uuid>/{metadata.json,output.txt}).
// NOTE (live-pinned): status "success" means the subagent RETURNED, not that
// its work is correct — the parent's integration checks are the gate.
async function collectSubagents(client, { sessionId, home }) {
  const result = await client.request('session/subagents', { sessionId }, { timeoutMs: 15000 });
  const items = (result && result.ended && result.ended.items) || [];
  const running = (result && result.running) || [];
  const agentsDir = path.join(home, '.zcode', 'cli', 'agents', sessionId);
  const readJson = (f) => {
    try {
      return JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch {
      return null;
    }
  };
  const subagents = items.map((item) => {
    const dir = path.join(agentsDir, `agent_${String(item.agentId || '').replace(/^agent_/, '')}`);
    const metadata = readJson(path.join(dir, 'metadata.json'));
    let output = null;
    try {
      output = fs.readFileSync(path.join(dir, 'output.txt'), 'utf8');
    } catch {
      /* not flushed */
    }
    return {
      agentId: item.agentId || (metadata && metadata.agentId) || null,
      childSessionId: item.childSessionId || (metadata && metadata.childSessionId) || null,
      profileId: (metadata && metadata.profileId) || item.subagentType || null,
      title: item.title || (metadata && metadata.description) || null,
      status: item.status || null,
      summary: item.summary || null,
      output,
      startedAt: item.startedAt || null,
      endedAt: item.endedAt || null,
      durationMs: item.startedAt && item.endedAt ? item.endedAt - item.startedAt : null,
    };
  });
  return { subagents, runningCount: running.length };
}

function sumUsage(turns) {
  let input = null;
  let output = null;
  for (const t of turns) {
    if (!t.usage) continue;
    if (typeof t.usage.inputTokens === 'number') input = (input || 0) + t.usage.inputTokens;
    if (typeof t.usage.outputTokens === 'number') output = (output || 0) + t.usage.outputTokens;
  }
  return input === null && output === null ? null : { inputTokens: input, outputTokens: output };
}

function exitCodeFor(result) {
  switch (result.status) {
    case 'completed':
      return 0;
    case 'unverified':
      return 9;
    case 'blocked':
      return 10;
    case 'partial':
      return 8;
    case 'cancelled':
      return 130;
    default: {
      const kind = result.error && result.error.kind;
      if (kind === 'timeout') return 124;
      if (kind === 'no_subagent') return 6;
      if (kind === 'checks_failed') return 8;
      if (kind === 'conflict' || kind === 'busy') return 7;
      return 5;
    }
  }
}

// Claims the id and writes the first record + settings (+ task.json).
// Used directly by detached starts so the id exists before the worker runs.
function prepareSession(inv, env = process.env) {
  const record = store.createSession(inv.id, {
    kind: inv.kind,
    label: inv.label || null,
    cwd: fs.realpathSync(inv.cwd),
    workspaceRoot: workspaceRoot(inv.cwd),
    owns: inv.ownsDisplay || [],
    ownsRoot: inv.owns || [],
    checks: inv.checks || [],
    model: inv.model,
    effort: inv.effort,
    engineSessionId: null,
  }, env);
  writeSettings(inv.id, inv, env);
  if (inv.kind === 'task') {
    store.writeJsonAtomic(path.join(store.sessionDir(inv.id, env), 'task.json'), inv.contract);
  }
  return record;
}

// inv: {kind, id, resume?:{message}, adopt?, cwd, model, effort, timeoutMs,
//   prompt (run/agent), contract (task), checks, owns, ownsDisplay, …}
// opts: {onEvent, signal, env, runtime}
// Returns the result object; throws ConfigError / ExecError / store errors
// for invocations that never started.
async function execute(inv, opts = {}) {
  const env = opts.env || process.env;
  const emit = opts.onEvent || (() => {});
  const signal = opts.signal || null;
  const started = Date.now();
  const deadline = started + inv.timeoutMs;
  const runtime = opts.runtime || resolveRuntime(env);
  const { scrub } = runtime;
  const id = inv.id;
  const dir = store.sessionDir(id, env);
  const home = path.join(dir, 'home');
  const root = workspaceRoot(inv.cwd);

  // --- record ---------------------------------------------------------------
  const resuming = Boolean(inv.resume);
  if (!resuming && !inv.adopt) prepareSession(inv, env);
  const record = store.readSession(id, env);
  if (!record) throw new ExecError(`no session "${id}"`, { exitCode: 2, kind: 'not_found' });
  const busy = () => new ExecError(
    `session "${id}" is still running (pid ${store.readSession(id, env).pid}). Wait for it or cancel it first.`,
    { exitCode: 7, kind: 'busy' }
  );
  if (resuming && !inv.adopt) {
    const view = store.viewSession(record);
    if (view.live && record.pid !== process.pid) throw busy();
  }
  // Atomic: exactly one live process drives this session.
  const releaseOwner = store.claimSession(id, env);
  if (!releaseOwner) throw busy();
  let releaseSlot = null;
  const releaseClaims = () => {
    if (releaseSlot) releaseSlot();
    releaseOwner();
  };
  if (resuming) writeSettings(id, inv, env);
  const isFirstInvocation = !record.engineSessionId;
  const update = (patch) => store.updateSession(id, patch, env);

  // --- activity relay ---------------------------------------------------------
  let lastWrite = 0;
  let toolCalls = record.activity ? record.activity.toolCalls || 0 : 0;
  let subagentsStarted = record.activity ? record.activity.subagentsStarted || 0 : 0;
  let lastTool = null;
  const relay = (ev) => {
    emit(ev);
    if (ev.type === 'stream') return;
    if (ev.type === 'tool') {
      if (ev.phase === 'started') {
        toolCalls++;
        lastTool = ev.name;
        if (SUBAGENT_TOOLS.has(ev.name)) {
          subagentsStarted++;
          emit({ type: 'subagent', phase: 'started', toolCallId: ev.id });
        }
      } else if ((ev.phase === 'result' || ev.phase === 'error') && SUBAGENT_TOOLS.has(ev.name)) {
        emit({ type: 'subagent', phase: ev.phase === 'result' ? 'returned' : 'error', toolCallId: ev.id });
      }
    }
    if (ev.type === 'model_request_started' || ev.type === 'state' || ev.type === 'turn') return;
    try {
      store.appendEvent(id, ev, env);
      const now = Date.now();
      if (now - lastWrite > 1000) {
        lastWrite = now;
        update({
          activity: { toolCalls, subagentsStarted, lastTool, lastEventAt: new Date(now).toISOString() },
        });
      }
    } catch {
      /* activity is best-effort; never fail the run over it */
    }
  };
  const setPhase = (phase, detail = {}) => {
    const ev = { type: 'phase', phase, ...detail };
    emit(ev);
    try {
      store.appendEvent(id, ev, env);
      update({ phase, activity: { toolCalls, subagentsStarted, lastTool, lastEventAt: new Date().toISOString() } });
    } catch {
      /* best-effort */
    }
  };

  emit({
    type: 'session',
    id,
    kind: inv.kind,
    label: inv.label || null,
    resumed: resuming,
    cwd: record.cwd,
    owns: inv.ownsDisplay || [],
    checks: inv.checks || [],
    model: inv.model,
    effort: inv.effort,
  });

  // --- capacity ---------------------------------------------------------------
  const maxActive = Number(env.ZAI_CODE_MAX_ACTIVE) || 8;
  update({ state: 'queued', phase: 'queued', pid: process.pid, status: null });
  releaseSlot = store.claimSlot(maxActive, env);
  if (!releaseSlot) {
    setPhase('queued', { reason: `${maxActive} sessions already running (ZAI_CODE_MAX_ACTIVE)` });
    while (!releaseSlot && !(signal && signal.aborted) && Date.now() < deadline) {
      await sleep(1000);
      releaseSlot = store.claimSlot(maxActive, env);
    }
  }

  // --- lease ------------------------------------------------------------------
  const lease = acquireLease({ id, root, owns: inv.owns || [], allowOverlap: inv.allowOverlap, env });
  if (!lease.ok) {
    const names = lease.conflicts
      .map((c) => `${c.id} (owns ${c.owns && c.owns.length ? c.owns.join(', ') : 'the whole workspace'})`)
      .join('; ');
    const message =
      `workspace conflict in ${root}: overlapping ownership with running session(s) ${names}. ` +
      'Declare disjoint --owns paths, use a separate worktree, wait for them, or pass --allow-overlap.';
    if (inv.adopt) {
      // A detached worker: the caller is polling this id, so leave a result.
      store.writeResult(id, {
        type: 'result', schema: RESULT_SCHEMA, ok: false, status: 'failed', id, kind: inv.kind,
        error: { kind: 'conflict', message }, issues: [message],
      }, env);
      update({ state: 'finished', phase: 'done', status: 'failed', outcome: { status: 'failed', issues: [message] } });
    } else if (!resuming) {
      store.deleteSession(id, env); // the id stays free for a later retry
    } else {
      update({ state: 'finished', phase: 'done', status: record.status });
    }
    releaseClaims();
    throw new ExecError(message, { exitCode: 7, kind: 'conflict' });
  }

  update({ state: 'running', phase: 'starting' });

  let client = null;
  let session = null;
  const turns = [];
  let checks = [];
  let repairs = 0;
  let parsed = { handback: null, report: '', error: 'missing' };
  let error = null;
  let userInput = null;
  let subagents = null;
  let subagentNote = null;
  let built = null;
  let before = null;
  const concurrent = new Map(lease.others.map((o) => [o.id, o.owns || []]));
  const checkTouched = new Set(); // files written by zcode's own check runs
  const invocationStart = new Date(started).toISOString();

  try {
    if (signal && signal.aborted) throw new TurnError('cancelled', { kind: 'cancelled' });
    if (!releaseSlot) throw new TurnError('run exceeded --timeout-ms while queued', { kind: 'timeout' });

    built = buildEngineHome({
      home,
      root: rootDir(env),
      key: runtime.key,
      live: liveDir(env),
      mcpSpecs: inv.mcpSpecs || [],
      mcpInherit: inv.mcpInherit,
      skillsDirs: inv.skillsDirs || [],
      noSkills: inv.noSkills,
    });
    before = snapshot(root);

    // Open the engine session; retry once on engine timeouts/exits (safe:
    // nothing has been sent to the model yet).
    setPhase('starting');
    for (let attempt = 1; ; attempt++) {
      client = makeClient(runtime, { home, cwd: record.cwd });
      client.start();
      update({ enginePid: client.child.pid });
      try {
        session = await openSession(client, {
          workspacePath: record.cwd,
          modelId: inv.model,
          effort: inv.effort,
          resumeSessionId: record.engineSessionId || null,
          requiredMcp: built.mcp.added,
          onEvent: relay,
        });
        break;
      } catch (err) {
        client.kill();
        const transient = /timeout|exited|failed to start|dead/.test(err.message);
        if (attempt >= 2 || !transient || (signal && signal.aborted) || Date.now() >= deadline) throw err;
        relay({ type: 'retry', phase: 'open_session', reason: scrub(err.message).slice(0, 300) });
      }
    }
    update({ engineSessionId: session.sessionId });

    // First prompt for this invocation.
    let prompt;
    if (inv.kind === 'task') {
      prompt = isFirstInvocation
        ? buildTaskPrompt(inv.contract, { ownsDisplay: inv.ownsDisplay || [] }) +
          (resuming && inv.resume.message ? `\n\n## Message from the orchestrator\n${inv.resume.message}` : '')
        : buildResumePrompt(inv.resume ? inv.resume.message : '', { kind: 'task' });
    } else if (inv.kind === 'agent') {
      prompt =
        `You MUST use the Agent tool (profileId: "${inv.profile}") to accomplish the ` +
        `task below — do not do the work yourself. When the subagent finishes, ` +
        `report its agent id and result.\n\nTask: ${inv.resume ? inv.resume.message : inv.prompt}`;
    } else {
      prompt = inv.resume ? buildResumePrompt(inv.resume.message, { kind: 'run' }) : inv.prompt;
    }

    let askedForHandback = false;
    let phase = 'executing';
    for (;;) {
      setPhase(phase, phase === 'repairing' ? { attempt: repairs, of: inv.maxRepairs } : {});
      const turn = await runTurn(client, session, {
        modelId: inv.model,
        effort: inv.effort,
        prompt,
        deadline,
        signal,
        keepReasoning: inv.includeReasoning,
        onEvent: relay,
      });
      turns.push(turn);
      update({ turns: (record.turns || 0) + turns.length });
      if (inv.kind !== 'task') break;

      const next = parseHandback(turn.response);
      // A handback-only follow-up keeps the substantive report from before.
      parsed = { ...next, report: next.report || parsed.report };
      if (parsed.error && !askedForHandback && Date.now() < deadline) {
        askedForHandback = true;
        prompt = HANDBACK_REQUEST;
        phase = 'reporting';
        continue;
      }
      if (parsed.handback && parsed.handback.status === 'blocked') break;
      if (!inv.checks.length) break;

      setPhase('checking', { count: inv.checks.length });
      const preChecks = before ? snapshot(root) : null;
      checks = await runChecks(inv.checks, {
        cwd: record.cwd,
        timeoutMs: Math.max(1000, Math.min(inv.checkTimeoutMs, deadline - Date.now())),
        signal,
        onEvent: relay,
      });
      if (preChecks) {
        for (const f of diffSnapshots(preChecks, snapshot(root)) || []) checkTouched.add(f.path);
      }
      if (Date.now() >= deadline && checks.some((c) => c.timedOut)) {
        throw new TurnError('run exceeded --timeout-ms during acceptance checks', { kind: 'timeout' });
      }
      const failures = checks.filter((c) => !c.ok);
      if (!failures.length || repairs >= inv.maxRepairs) break;
      if ((signal && signal.aborted) || Date.now() >= deadline) break;
      repairs++;
      prompt = buildRepairPrompt(failures, { attempt: repairs, maxRepairs: inv.maxRepairs });
      phase = 'repairing';
    }

    if (inv.kind === 'task' || inv.kind === 'agent') {
      try {
        const collected = await collectSubagents(client, { sessionId: session.sessionId, home });
        subagents = collected.subagents;
        if (collected.runningCount) subagentNote = `${collected.runningCount} subagent(s) still running at handback`;
      } catch (err) {
        subagentNote = `subagent report unavailable: ${scrub(err.message).slice(0, 200)}`;
        if (inv.kind === 'agent') throw new TurnError(subagentNote, { kind: 'subagents_rpc' });
      }
    }
  } catch (err) {
    error = err;
  } finally {
    if (client) client.kill();
    lease.release();
    releaseClaims();
  }

  // --- assemble the handback --------------------------------------------------
  const cancelled = Boolean(signal && signal.aborted) || (error && error.kind === 'cancelled');
  if (error && error.kind === 'user_input') {
    userInput = error.message.replace(/^headless run requested user input: /, '');
  }
  for (const lease2 of liveLeases(root, env)) {
    if (lease2.id !== id) concurrent.set(lease2.id, lease2.owns || []);
  }
  // Sessions in this workspace that were active at any point during this
  // invocation, including ones that finished before us (their leases are
  // gone): their changes are theirs, not scope violations of ours.
  for (const other of store.listSessions(env)) {
    if (other.id === id || other.workspaceRoot !== root || concurrent.has(other.id)) continue;
    if (String(other.updatedAt) >= invocationStart && Array.isArray(other.ownsRoot)) {
      concurrent.set(other.id, other.ownsRoot);
    }
  }
  const after = before ? snapshot(root) : null;
  const diff = before ? diffSnapshots(before, after) : null;
  const owns = inv.owns || [];
  const files = (diff || [])
    .filter((f) => !f.path.startsWith('.zcode/'))
    .map((f) => {
      const owned = isOwned(f.path, owns);
      const by = owned
        ? null
        : [...concurrent.entries()].find(([, o]) => o.length && isOwned(f.path, o));
      const fromChecks = !owned && !by && checkTouched.has(f.path);
      return { ...f, owned, ...(by ? { concurrentSession: by[0] } : {}), ...(fromChecks ? { fromChecks: true } : {}) };
    });
  const scopeViolations = files
    .filter((f) => !f.owned && !f.concurrentSession && !f.fromChecks)
    .map((f) => f.path);

  const handback = parsed.handback;
  let { status, issues } = deriveStatus({
    kind: inv.kind,
    error: error && !cancelled && error.kind !== 'user_input' ? error : null,
    cancelled,
    userInput,
    handback,
    handbackError: parsed.error,
    checks,
    scopeViolations,
  });

  let errorOut = null;
  if (status === 'failed') {
    if (error) errorOut = { kind: error.kind || 'error', message: scrub(error.message) };
    else if (checks.some((c) => !c.ok)) errorOut = { kind: 'checks_failed', message: issues[0] };
  } else if (status === 'cancelled') {
    errorOut = { kind: 'cancelled', message: 'cancelled' };
  }
  if (inv.kind === 'agent' && status === 'completed') {
    const ok = subagents && subagents.length >= 1 && subagents.every((s) => s.status === 'success');
    if (!ok) {
      status = 'failed';
      const why = !subagents || subagents.length === 0
        ? 'no subagent was dispatched'
        : `subagent statuses: ${subagents.map((s) => s.status).join(', ')}`;
      issues = [why];
      errorOut = { kind: 'no_subagent', message: why };
    }
  }

  const notVerified = [];
  if (inv.kind === 'task') {
    if (!inv.checks.length) notVerified.push('no acceptance checks were declared; nothing was executed by zcode to verify the work');
    if (inv.acceptanceDeclared) notVerified.push('prose acceptance criteria are confirmed only by the executor\'s own report');
    if (subagents && subagents.length) notVerified.push('subagent "success" means the subagent returned; only the integrated result is verified');
  }
  if (before && !diff) notVerified.push('changed files could not be tracked in this workspace');
  if (subagentNote) issues.push(subagentNote);

  const last = turns[turns.length - 1] || null;
  const response = last ? last.response : '';
  const questions = [...(handback ? handback.questions : [])];
  if (userInput) questions.push(userInput);

  const result = {
    type: 'result',
    schema: RESULT_SCHEMA,
    ok: status === 'completed',
    status,
    id,
    kind: inv.kind,
    label: inv.label || null,
    summary: handback && handback.summary ? handback.summary : '',
    response: inv.kind === 'task' ? parsed.report : response,
    issues,
    questions,
    unresolved: handback ? handback.unresolved : [],
    notVerified,
    changes: {
      tracking: before ? (diff ? before.kind : 'unavailable') : 'not-started',
      files,
    },
    scopeViolations,
    checks: checks.map((c) => ({
      command: c.command,
      ok: c.ok,
      exitCode: c.exitCode,
      timedOut: c.timedOut,
      durationMs: c.durationMs,
      output: scrub(c.output),
    })),
    checksPassed: checks.length ? checks.every((c) => c.ok) : null,
    repairs,
    handback,
    subagents,
    error: errorOut,
    cwd: record.cwd,
    workspaceRoot: root,
    owns: inv.ownsDisplay || [],
    sessionId: session ? session.sessionId : record.engineSessionId || null,
    resumed: resuming || Boolean(session && session.resumed),
    turns: turns.length,
    model: (last && last.engineModel) || inv.model,
    modelRequested: inv.model,
    effort: (last && last.engineReasoningLevel) || inv.effort,
    effortRequested: inv.effort,
    mode: session ? session.mode : null,
    usage: sumUsage(turns),
    reasoningChars: turns.reduce((n, t) => n + t.reasoningChars, 0),
    toolCalls: turns.some((t) => typeof t.toolCallCount === 'number')
      ? turns.reduce((n, t) => n + (t.toolCallCount || 0), 0)
      : null,
    toolEvents: turns.reduce((n, t) => n + t.toolEvents, 0),
    mcpServers: built ? Object.keys(built.mcp.servers) : [],
    skillsInjected: built ? built.skillsInjected : [],
    terminalStatus: last ? last.terminalStatus : null,
    streamingEvents: turns.reduce((n, t) => n + t.streamingEvents, 0),
    durationMs: Date.now() - started,
    files: {
      session: dir,
      result: path.join(dir, 'result.json'),
      events: path.join(dir, 'events.ndjson'),
    },
  };
  if (inv.includeReasoning) result.reasoning = turns.map((t) => t.reasoningText).join('');

  store.writeResult(id, result, env);
  store.appendEvent(id, { type: 'result', status }, env);
  update({
    state: 'finished',
    phase: 'done',
    status,
    activity: { toolCalls, subagentsStarted, lastTool, lastEventAt: new Date().toISOString() },
    outcome: {
      status,
      summary: result.summary,
      issues: issues.slice(0, 5),
      checksPassed: result.checksPassed,
      changedFiles: files.length,
      durationMs: result.durationMs,
    },
  });
  return result;
}

module.exports = { execute, prepareSession, exitCodeFor, ExecError, readSettings, RESULT_SCHEMA };

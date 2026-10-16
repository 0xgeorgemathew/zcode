'use strict';
// lib/commands/sessions.js — status | wait | result | cancel. Read-only views over
// the session store (plus a signal for cancel); none of them spawns the
// engine or needs the API key, so they are instant and safe to poll.
const store = require('../store.js');
const { buildBrief } = require('../brief.js');
const { formatResult, formatSessionRow, formatSessionView, phaseText, useColor } = require('../ui.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function resolveOrExit(ref, json) {
  const id = store.resolveSessionId(ref);
  if (!id) {
    if (json) process.stdout.write(JSON.stringify({ type: 'error', error: 'not_found', id: ref }) + '\n');
    process.stderr.write(`zcode: no session "${ref}" (see "zcode status").\n`);
    process.exit(2);
  }
  return id;
}

// The handback for a finished session, or a synthetic one when the owning
// process died without writing it (or is mid-resume of an older result).
function finalResult(view) {
  const result = store.readResult(view.id);
  if (view.state === 'finished' && result) return result;
  return {
    type: 'result',
    ok: false,
    status: 'failed',
    id: view.id,
    kind: view.kind,
    error: {
      kind: 'interrupted',
      message: `the process running this session exited without a handback; continue with "zcode resume ${view.id}"`,
    },
    issues: ['interrupted before completion'],
    durationMs: 0,
  };
}

function statusPayload(view, { events = 10 } = {}) {
  const payload = { type: 'status', ...view, ...store.idleInfo(view), recent: store.readEvents(view.id, { tail: events }) };
  if (view.state === 'finished' || view.state === 'interrupted') payload.result = finalResult(view);
  return payload;
}

const STATUS_RECENT = 15;

async function status(parsed) {
  const { flags, prompts } = parsed;
  if (prompts.length === 0) {
    const everything = store.listSessions();
    if (flags.json) {
      process.stdout.write(JSON.stringify({ type: 'sessions', sessions: everything.slice(0, 50).map(summaryOf) }) + '\n');
    } else if (everything.length === 0) {
      process.stdout.write('no sessions\n');
    } else {
      // Most recent first; the rest is one line, `--all` lists everything.
      const shown = flags.all ? everything : everything.slice(0, STATUS_RECENT);
      for (const s of shown) process.stdout.write(formatSessionRow(s) + '\n');
      if (shown.length < everything.length) {
        process.stdout.write(`… ${everything.length - shown.length} more (zcode status --all)\n`);
      }
    }
    process.exit(0);
  }
  const id = resolveOrExit(prompts[0], flags.json);
  const view = store.viewSession(store.readSession(id));
  const payload = statusPayload(view);
  Object.assign(view, store.idleInfo(view));
  if (flags.json) {
    process.stdout.write(JSON.stringify(payload) + '\n');
  } else {
    process.stdout.write(formatSessionView(view, { events: payload.recent.slice(-8) }));
    if (payload.result) process.stdout.write('\n' + formatResult(payload.result, { color: useColor(process.stdout) }));
  }
  process.exit(0);
}

function summaryOf(s) {
  return {
    id: s.id,
    kind: s.kind,
    label: s.label,
    state: s.state,
    status: s.status,
    phase: s.phase,
    cwd: s.cwd,
    owns: s.owns,
    updatedAt: s.updatedAt,
  };
}

const isDone = (view) => view.state === 'finished' || view.state === 'interrupted';

// `12m`, `45s`, `1h05m`: how long a session has been alive, for one-line views.
function formatElapsed(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
}

// What a still-running session costs the reader on a wait timeout: exactly
// one line, nothing else.
function pendingLine(view, json) {
  const elapsedMs = Math.max(0, Date.now() - Date.parse(view.createdAt || view.updatedAt || Date.now()));
  const idle = store.idleInfo(view);
  if (json) return JSON.stringify({ type: 'pending', id: view.id, state: view.state, phase: view.phase, elapsedMs, ...idle });
  return `${view.id} ${view.state} ${view.phase} ${formatElapsed(elapsedMs)}${idle && idle.stalled ? ` idle ${formatElapsed(idle.idleMs)} STALLED?` : ''}`;
}

// A finished session's handback in the requested form.
function printResult(result, { json, full }) {
  if (json) process.stdout.write(JSON.stringify(full ? result : buildBrief(result)) + '\n');
  else process.stdout.write(formatResult(result, { color: useColor(process.stdout) }));
}

// Blocks until every id is finished (or interrupted), printing each
// handback as it lands (--any: until the FIRST one finishes; the rest keep
// running). Exit 0 iff all completed; otherwise the exit code of the first
// one that did not (--any: that of the one reported). On --timeout-ms: one
// line per pending session and exit 124.
async function wait(parsed) {
  const { flags, prompts, given } = parsed;
  if (prompts.length === 0) {
    process.stderr.write('zcode: wait needs at least one session id.\n');
    process.exit(2);
  }
  const { exitCodeFor } = require('../executor.js');
  const ids = prompts.map((p) => resolveOrExit(p, flags.json));
  const deadline = given.has('timeoutMs') ? Date.now() + flags.timeoutMs : Infinity;
  const pending = new Set(ids);
  let code = 0;
  for (;;) {
    for (const id of ids) {
      if (!pending.has(id)) continue;
      const view = store.viewSession(store.readSession(id));
      if (!isDone(view)) continue;
      pending.delete(id);
      const result = finalResult(view);
      const c = exitCodeFor(result);
      printResult(result, { json: flags.json, full: flags.full });
      if (flags.any) process.exit(c);
      if (c !== 0 && code === 0) code = c;
    }
    if (pending.size === 0) process.exit(code);
    if (Date.now() >= deadline) {
      for (const id of ids) {
        if (!pending.has(id)) continue;
        process.stdout.write(pendingLine(store.viewSession(store.readSession(id)), flags.json) + '\n');
      }
      process.exit(124);
    }
    await sleep(500);
  }
}

// result <id>: the handback of a finished session, without waiting. Brief
// as JSON with --json, the human view otherwise; --full prints the full
// record (JSON).
async function result(parsed) {
  const { flags, prompts } = parsed;
  if (prompts.length !== 1) {
    process.stderr.write('zcode: result needs exactly one session id.\n');
    process.exit(2);
  }
  const id = resolveOrExit(prompts[0], flags.json);
  const view = store.viewSession(store.readSession(id));
  if (!isDone(view)) {
    process.stderr.write(`zcode: ${id} is still ${view.state} (phase ${view.phase}); use "zcode wait ${id}".\n`);
    process.exit(7);
  }
  const r = finalResult(view);
  if (flags.full) process.stdout.write(JSON.stringify(r) + '\n');
  else printResult(r, { json: flags.json, full: false });
  process.exit(0);
}

// SIGTERM to the owning process; it stops the engine turn, kills checks,
// records "cancelled". Escalates to SIGKILL after 15 s and records the
// cancellation itself. Idempotent: cancelling a finished session is a no-op.
async function cancel(parsed) {
  const { flags, prompts } = parsed;
  if (prompts.length !== 1) {
    process.stderr.write('zcode: cancel needs exactly one session id.\n');
    process.exit(2);
  }
  const id = resolveOrExit(prompts[0], flags.json);
  let view = store.viewSession(store.readSession(id));
  const report = (outcome) => {
    const v = store.viewSession(store.readSession(id));
    if (flags.json) process.stdout.write(JSON.stringify({ type: 'cancel', id, outcome, state: v.state, status: v.status }) + '\n');
    else process.stdout.write(`${id}: ${outcome} (${v.state === 'finished' ? v.status : v.state})\n`);
    process.exit(0);
  };
  if (!view.live) return report('not running');
  try {
    process.kill(view.pid, 'SIGTERM');
  } catch {
    /* exited in between */
  }
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    await sleep(250);
    view = store.viewSession(store.readSession(id));
    if (!view.live) return report('cancelled');
  }
  for (const target of [view.pid, -view.enginePid]) {
    if (!target) continue;
    try {
      process.kill(target, 'SIGKILL'); // negative = the engine's process group
    } catch {
      /* gone */
    }
  }
  const result = {
    type: 'result',
    ok: false,
    status: 'cancelled',
    id,
    kind: view.kind,
    error: { kind: 'cancelled', message: 'killed after not stopping within 15s' },
    issues: ['cancelled (forced)'],
    durationMs: 0,
  };
  store.writeResult(id, result);
  store.updateSession(id, { state: 'finished', phase: 'done', status: 'cancelled' });
  return report('killed');
}

// One line per watched session: `id  state phase[ n/m]  elapsed  last: <tool>
// <age> ago  req <n>  sub <running>` (+ STALLED? when running and silent).
function watchLine(view, { stallMin, now = Date.now() }) {
  const done = isDone(view);
  const state = view.state === 'finished' ? view.status || 'finished' : view.state;
  const a = view.activity || {};
  const idle = store.idleInfo(view, { stallMin, now });
  const end = done ? Date.parse(view.updatedAt) : now;
  const elapsed = formatElapsed(end - Date.parse(view.createdAt || view.updatedAt));
  const last = a.lastTool
    ? `last: ${a.lastTool}${a.lastToolAt ? ` ${formatElapsed(now - Date.parse(a.lastToolAt))} ago` : ''}`
    : 'last: -';
  const phase = done ? '' : ` ${phaseText(view)}`;
  const stalled = idle && idle.stalled ? '  STALLED?' : '';
  const text = `${view.id}  ${state}${phase}  ${elapsed}  ${last}  req ${a.modelRequests || 0}  sub ${a.subagentsRunning || 0}${stalled}`;
  // The change signature leaves out the clocks (elapsed, ages).
  const sig = [view.id, state, phase, a.lastTool, a.modelRequests || 0, a.subagentsRunning || 0, Boolean(stalled)].join('|');
  return { text, sig, done };
}

// watch [<id>… | --plan <name>] [--stall-min n]: live view, no Opus tokens.
// TTY: redraw every 2 s; otherwise print a session's line when it changes.
// No args: live sessions plus those finished in the last 10 min. Exits when
// every watched session is finished; Ctrl-C exits 0.
async function watch(parsed) {
  const { flags, prompts } = parsed;
  const stallMin = parsed.given.has('stallMin') ? flags.stallMin : store.STALL_MIN;
  const poll = Number(process.env.ZCODE_WATCH_POLL_MS) || 2000;
  const tty = Boolean(process.stdout.isTTY);
  process.on('SIGINT', () => process.exit(0));
  let planCtx = null;
  if (flags.plan) {
    const plans = require('../plan.js');
    const state = store.readPlanState(flags.plan);
    if (!state) {
      process.stderr.write(`zcode: no plan "${flags.plan}" (zcode plan run <file> starts one).\n`);
      process.exit(2);
    }
    planCtx = { plans, state, r: plans.resolvePlan(state.file, state.cwd) };
  }
  const ids = prompts.map((p) => resolveOrExit(p, false));
  const pick = () => {
    if (ids.length) return ids.map((id) => store.viewSession(store.readSession(id))).filter(Boolean);
    if (planCtx) {
      return planCtx.plans.sessionList(planCtx.r.plan)
        .map((s) => store.readSession(s.id)).filter(Boolean).map((rec) => store.viewSession(rec));
    }
    const cutoff = Date.now() - 10 * 60000;
    return store.listSessions().filter((v) => !isDone(v) || Date.parse(v.updatedAt) >= cutoff).reverse();
  };
  const planDone = () => planCtx.plans.planReport(flags.plan, planCtx.r, store.readPlanState(flags.plan), { briefs: false }).status !== 'running';
  const seen = new Map();
  let drawn = 0;
  for (;;) {
    const views = pick();
    if (!views.length && !planCtx) {
      process.stdout.write('no live sessions\n');
      process.exit(0);
    }
    const lines = views.map((v) => watchLine(v, { stallMin }));
    if (tty) {
      process.stdout.write(`${drawn ? `\x1b[${drawn}F\x1b[J` : ''}${lines.map((l) => l.text).join('\n')}${lines.length ? '\n' : ''}`);
      drawn = lines.length;
    } else {
      for (const l of lines) {
        const id = l.text.split('  ')[0];
        if (seen.get(id) === l.sig) continue;
        seen.set(id, l.sig);
        process.stdout.write(l.text + '\n');
      }
    }
    const finished = planCtx ? planDone() : lines.every((l) => l.done);
    if (finished && (lines.length || planCtx)) process.exit(0);
    await sleep(poll);
  }
}

module.exports = async function sessions(parsed) {
  if (parsed.command === 'watch') return watch(parsed);
  if (parsed.command === 'status') return status(parsed);
  if (parsed.command === 'wait') return wait(parsed);
  if (parsed.command === 'result') return result(parsed);
  return cancel(parsed);
};

module.exports.finalResult = finalResult;

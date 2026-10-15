'use strict';
// lib/commands/sessions.js — status | wait | cancel. Read-only views over
// the session store (plus a signal for cancel); none of them spawns the
// engine or needs the API key, so they are instant and safe to poll.
const store = require('../store.js');
const { formatResult, formatSessionRow, formatSessionView, useColor } = require('../ui.js');

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
  const payload = { type: 'status', ...view, recent: store.readEvents(view.id, { tail: events }) };
  if (view.state === 'finished' || view.state === 'interrupted') payload.result = finalResult(view);
  return payload;
}

async function status(parsed) {
  const { flags, prompts } = parsed;
  if (prompts.length === 0) {
    const all = store.listSessions().slice(0, 50);
    if (flags.json) {
      process.stdout.write(JSON.stringify({ type: 'sessions', sessions: all.map(summaryOf) }) + '\n');
    } else if (all.length === 0) {
      process.stdout.write('no sessions\n');
    } else {
      for (const s of all) process.stdout.write(formatSessionRow(s) + '\n');
    }
    process.exit(0);
  }
  const id = resolveOrExit(prompts[0], flags.json);
  const view = store.viewSession(store.readSession(id));
  const payload = statusPayload(view);
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

// Blocks until every id is finished (or interrupted), printing each
// handback as it lands. Exit 0 iff all completed; otherwise the exit code
// of the first one that did not (124 when --timeout-ms elapses first).
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
    for (const id of [...pending]) {
      const view = store.viewSession(store.readSession(id));
      if (view.state !== 'finished' && view.state !== 'interrupted') continue;
      pending.delete(id);
      const result = finalResult(view);
      const c = exitCodeFor(result);
      if (c !== 0 && code === 0) code = c;
      if (flags.json) process.stdout.write(JSON.stringify(result) + '\n');
      else process.stdout.write(formatResult(result, { color: useColor(process.stdout) }));
    }
    if (pending.size === 0) process.exit(code);
    if (Date.now() >= deadline) {
      for (const id of pending) {
        const view = store.viewSession(store.readSession(id));
        if (flags.json) process.stdout.write(JSON.stringify(statusPayload(view, { events: 3 })) + '\n');
        else process.stderr.write(`zcode: ${id} still ${view.state} (phase ${view.phase})\n`);
      }
      process.exit(124);
    }
    await sleep(500);
  }
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

module.exports = async function sessions(parsed) {
  if (parsed.command === 'status') return status(parsed);
  if (parsed.command === 'wait') return wait(parsed);
  return cancel(parsed);
};

module.exports.finalResult = finalResult;

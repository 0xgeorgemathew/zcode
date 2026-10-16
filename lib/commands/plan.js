'use strict';
// lib/commands/plan.js — plan check|run|wait|status|resume, and __plan (the
// detached supervisor). Logic lives in lib/plan.js.
//
// Output contract: JSON mode prints exactly one line per call (plan check:
// {type:"plan-check"}; run/wait/status/resume: {type:"plan",name,status,
// sessions:[{id,status}],briefs:[…]}; a timeout or --detach: the same
// without briefs). `plan run --preflight` prints one brief per session with
// questions. Exit codes: 0 completed · 10 blocked · 8 partial/failed ·
// 124 timeout · 2 usage · 7 plan exists.
const store = require('../store.js');
const plans = require('../plan.js');
const { buildBrief } = require('../brief.js');
const { exitCodeFor } = require('../executor.js');
const { questionText } = require('../contract.js');
const { formatResult, useColor } = require('../ui.js');

const out = (line) => process.stdout.write(line + '\n');

function die(code, message) {
  process.stderr.write(`zcode: ${message}\n`);
  process.exit(code);
}

function load(file, parsed) {
  if (!file) die(2, 'plan needs a plan file.');
  try {
    return plans.resolvePlan(file, parsed.given.has('cwd') ? parsed.flags.cwd : undefined);
  } catch (err) {
    if (err instanceof plans.PlanError) return die(2, err.message);
    throw err;
  }
}

function nameOf(parsed, file) {
  try {
    return plans.planName(parsed.flags.id, file);
  } catch (err) {
    if (err instanceof plans.PlanError) return die(2, err.message);
    throw err;
  }
}

// A plan by name (state + its plan file), or exit 2.
function open(name) {
  const state = store.readPlanState(name);
  if (!state) die(2, `no plan "${name}" (zcode plan run <file> starts one).`);
  try {
    return { state, r: plans.resolvePlan(state.file, state.cwd) };
  } catch (err) {
    if (err instanceof plans.PlanError) return die(2, err.message);
    throw err;
  }
}

function problemsOrExit(problems, json) {
  if (!problems.length) return;
  if (json) out(JSON.stringify({ type: 'plan-check', ok: false, problems }));
  for (const p of problems) process.stderr.write(`zcode: ${p}\n`);
  process.exit(2);
}

// One line per session; a non-completed session adds its one-line summary,
// a blocked one its questions.
function humanReport(report) {
  const brief = new Map((report.briefs || []).map((b) => [b.id, b]));
  const lines = [];
  for (const s of report.sessions) {
    const b = brief.get(s.id);
    const note = b && (b.summary || (b.error && b.error.message) || '');
    lines.push(`${s.id} ${s.status}${note ? ` - ${note.replace(/\s+/g, ' ').slice(0, 120)}` : ''}`);
    if (b && b.questions) for (const q of b.questions) lines.push(`  ? ${questionText(q).replace(/\n/g, '\n  ')}`);
  }
  return lines.join('\n');
}

function print(report, flags) {
  if (flags.json) out(JSON.stringify(report));
  else {
    process.stderr.write(`plan ${report.name}: ${report.status}\n`);
    out(humanReport(report));
  }
}

const reportOf = (name) => {
  const { state, r } = open(name);
  return plans.planReport(name, r, state);
};

function finish(report, flags) {
  print(report, flags);
  process.exit(plans.exitCodeForPlan(report.status));
}

// Timeout / detach summary: statuses only.
function brief(name, flags, status) {
  const { state, r } = open(name);
  const report = plans.planReport(name, r, state, { briefs: false });
  if (status) report.status = status;
  print(report, flags);
}

// Supervises in-process until the plan settles (or the deadline). On a
// deadline the supervision is handed to a detached supervisor so the plan
// keeps going.
async function superviseAndReport(name, flags, given) {
  const deadline = given.has('timeoutMs') ? Date.now() + flags.timeoutMs : Infinity;
  const res = await plans.supervise(name, { deadline });
  if (res.timedOut) {
    plans.startSupervisor(name);
    brief(name, flags, 'running');
    process.exit(124);
  }
  if (res.busy) {
    // Another supervisor already drives it: just wait for it.
    return waitFor(name, flags, given);
  }
  return finish(reportOf(name), flags);
}

async function waitFor(name, flags, given) {
  const deadline = given.has('timeoutMs') ? Date.now() + flags.timeoutMs : Infinity;
  for (;;) {
    const report = reportOf(name);
    if (report.status !== 'running') return finish(report, flags);
    if (Date.now() >= deadline) {
      brief(name, flags, 'running');
      process.exit(124);
    }
    await plans.sleep(plans.POLL_MS);
  }
}

async function check(parsed, file) {
  const r = load(file, parsed);
  const name = nameOf(parsed, file);
  const problems = plans.checkPlan(r, { name, state: store.readPlanState(name) });
  problemsOrExit(problems, parsed.flags.json);
  const n = plans.sessionList(r.plan).length;
  if (parsed.flags.json) out(JSON.stringify({ type: 'plan-check', ok: true, name, sessions: n }));
  else out(`plan ${name}: ${n} session${n === 1 ? '' : 's'}, ok`);
  process.exit(0);
}

async function run(parsed, file) {
  const { flags, given } = parsed;
  const r = load(file, parsed);
  const name = nameOf(parsed, file);
  const state = store.readPlanState(name);
  if (flags.preflight) return preflight(parsed, r, name, state);
  if (state) {
    die(7, `plan "${name}" already exists. Continue it with "zcode plan resume ${name}" (status: "zcode plan status ${name}"), or run again with another --id.`);
  }
  problemsOrExit(plans.checkPlan(r, { name }), flags.json);
  const ok = store.createPlanState(name, {
    file: r.file,
    cwd: r.cwd,
    sessions: plans.sessionList(r.plan).map((s) => s.id),
    supervisor: null,
    launchErrors: {},
  });
  if (!ok) die(7, `plan "${name}" already exists. Continue it with "zcode plan resume ${name}".`);
  return startSupervision(name, flags, given);
}

async function startSupervision(name, flags, given) {
  if (flags.detach) {
    plans.startSupervisor(name);
    out(JSON.stringify({ type: 'plan', name, status: 'running' }));
    process.exit(0);
  }
  return superviseAndReport(name, flags, given);
}

// Preflight every session (read-only, in parallel, as "<id>.pre"), wait for
// all, print one brief per session that has questions. Creates no plan state.
async function preflight(parsed, r, name, state) {
  const { flags, given } = parsed;
  problemsOrExit(plans.checkPlan(r, { name, state }), flags.json);
  const sessions = plans.sessionList(r.plan);
  const e = require('./exec.js');
  const ids = [];
  const failed = [];
  for (const s of sessions) {
    const pre = `${s.id}.pre`;
    const old = store.readSession(pre);
    if (old) {
      if (store.viewSession(old).live) die(7, `preflight session "${pre}" is still running; cancel it first (zcode cancel ${pre}).`);
      store.deleteSession(pre);
    }
    try {
      e.startDetached(plans.sessionInvocation(r, name, s, { id: pre, preflight: true }));
      ids.push(pre);
    } catch (err) {
      if (err instanceof e.UsageError || err.exitCode || err instanceof store.SessionExistsError) {
        failed.push(plans.launchFailure(pre, err.message));
      } else throw err;
    }
  }
  const { finalResult } = require('./sessions.js');
  const deadline = Date.now() + (given.has('timeoutMs') ? flags.timeoutMs : 600000);
  const pending = new Set(ids);
  const results = [...failed];
  for (;;) {
    for (const id of [...pending]) {
      const view = store.viewSession(store.readSession(id));
      if (view.state === 'finished' || view.state === 'interrupted') {
        pending.delete(id);
        results.push(finalResult(view));
      }
    }
    if (!pending.size) break;
    if (Date.now() >= deadline) {
      for (const id of pending) {
        const v = store.viewSession(store.readSession(id));
        out(flags.json ? JSON.stringify({ type: 'pending', id, state: v.state, phase: v.phase }) : `${id} ${v.state} ${v.phase}`);
      }
      process.exit(124);
    }
    await plans.sleep(plans.POLL_MS);
  }
  const asked = results.filter((x) => x.questions && x.questions.length);
  const broken = results.filter((x) => !(x.questions && x.questions.length) && x.status !== 'completed');
  for (const x of [...asked, ...broken]) {
    if (flags.json) out(JSON.stringify(buildBrief(x)));
    else out(formatResult(x, { color: useColor(process.stdout) }));
  }
  if (!asked.length && !broken.length) {
    if (flags.json) out(JSON.stringify({ type: 'preflight', name, status: 'completed', sessions: ids.length }));
    else out(`plan ${name}: preflight found no open questions (${ids.length} session${ids.length === 1 ? '' : 's'})`);
  }
  process.exit(asked.length ? 10 : broken.length ? Math.max(...broken.map((x) => exitCodeFor(x))) : 0);
}

async function resume(parsed, name, words) {
  const { flags, given } = parsed;
  const { state, r } = open(name);
  const text = words.join(' ').trim();
  const statuses = plans.sessionStatuses(r, state);
  const RESUMABLE = new Set(['failed', 'partial', 'unverified', 'blocked', 'cancelled', 'interrupted']);
  let targets;
  if (flags.session) {
    const e = statuses.get(flags.session);
    if (!e) die(2, `plan "${name}" has no session "${flags.session}".`);
    if (!RESUMABLE.has(e.status) || !e.view) die(2, `session "${flags.session}" is ${e.status}; only failed, partial, unverified, blocked, cancelled or interrupted sessions resume.`);
    targets = [flags.session];
  } else {
    targets = plans.sessionList(r.plan).map((s) => s.id).filter((id) => RESUMABLE.has(statuses.get(id).status) && statuses.get(id).view);
  }
  const blocked = targets.filter((id) => statuses.get(id).status === 'blocked');
  if (blocked.length && !text) {
    die(2, `${blocked.join(', ')} ${blocked.length === 1 ? 'is' : 'are'} blocked: answer the questions: zcode plan resume ${name} "…" (or --session <id> "…" for one session)`);
  }
  if (!targets.length && !flags.session && ![...statuses.values()].some((x) => x.status === 'pending' || x.status === 'skipped')) {
    // nothing to resume: report as is
    return finish(plans.planReport(name, r, state), flags);
  }
  const message = text || 'Continue: fix the remaining issues.';
  for (const id of targets) {
    const refusal = plans.resumeSession(id, message);
    if (refusal) die(7, refusal);
  }
  // Launch failures recorded earlier are retried by the supervisor.
  if (state.launchErrors && Object.keys(state.launchErrors).length) {
    store.updatePlanState(name, { launchErrors: {} });
  }
  return startSupervision(name, flags, given);
}

// Detached supervisor process: `zcode __plan <name>`.
async function supervisorWorker(name) {
  if (!store.readPlanState(name)) die(2, `no plan "${name}".`);
  await plans.supervise(name);
  process.exit(0);
}

module.exports = async function plan(parsed) {
  if (parsed.command === '__plan') return supervisorWorker(parsed.prompts[0]);
  const [sub, ...rest] = parsed.prompts;
  switch (sub) {
    case 'check':
      return check(parsed, rest[0]);
    case 'run':
      return run(parsed, rest[0]);
    case 'wait':
    case 'status': {
      if (!rest[0]) die(2, `plan ${sub} needs a plan name.`);
      open(rest[0]);
      if (sub === 'wait') return waitFor(rest[0], parsed.flags, parsed.given);
      print(reportOf(rest[0]), parsed.flags);
      process.exit(0);
    }
    case 'resume':
      if (!rest[0]) die(2, 'plan resume needs a plan name.');
      return resume(parsed, rest[0], rest.slice(1));
    default:
      return die(2, 'plan needs a subcommand: check | run | wait | status | resume (zcode --help).');
  }
};

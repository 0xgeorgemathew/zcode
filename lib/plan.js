'use strict';
// zcode plan: a DAG of task sessions from one plan file, run by a supervisor.
//
// The plan file ({cwd?, decisions?, context?, files?, model?, effort?,
// sessions:[{id, after?, ...contract keys}]}) is validated up front
// (checkPlan), then a supervisor launches each session as a detached zcode
// session once everything it is `after` has completed. The sessions are the
// source of truth: a plan's status is derived from their records (plus
// "never started" for sessions that were not launched), so it stays accurate
// when the supervisor dies. <root>/plans/<name>.json only remembers the plan
// file, the supervisor pid and launches that failed before a session existed.
//
// No process.exit in here: lib/commands/plan.js owns the CLI.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const store = require('./store.js');
const { buildContract } = require('./taskspec.js');
const { ContractError } = require('./contract.js');
const { workspaceRoot, normalizeOwns, ownsOverlap, OwnershipError } = require('./workspace.js');
const { normalizeModel, normalizeEffort, effortProblem, unknownModelMessage, DEFAULT_MODEL } = require('./models.js');
const { buildBrief } = require('./brief.js');

const BIN = path.join(__dirname, '..', 'bin', 'zcode.js');
const PLAN_KEYS = ['cwd', 'decisions', 'context', 'files', 'model', 'effort', 'limits', 'sessions'];
const POLL_MS = 500;

class PlanError extends Error {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const toArray = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);

// Reads and parses the plan file. `cwdOverride` is an explicit --cwd; else the
// plan's "cwd" (relative to the plan file); else the process cwd.
function resolvePlan(file, cwdOverride) {
  const abs = path.resolve(file);
  let text;
  try {
    text = fs.readFileSync(abs, 'utf8');
  } catch {
    throw new PlanError(`plan file "${file}" could not be read.`);
  }
  let plan;
  try {
    plan = JSON.parse(text);
  } catch (err) {
    throw new PlanError(`plan file "${file}" is not valid JSON: ${err.message}`);
  }
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) throw new PlanError('plan must be a JSON object.');
  const dir = path.dirname(abs);
  const cwd = cwdOverride ? path.resolve(cwdOverride) : plan.cwd ? path.resolve(dir, String(plan.cwd)) : process.cwd();
  return { file: abs, dir, cwd, plan };
}

// Plan name: --id, else the plan file's basename without extension.
function planName(id, file) {
  const name = id || path.basename(file, path.extname(file));
  if (!store.validId(name)) {
    throw new PlanError(`plan name "${name}" is not a valid id (letters, digits, ".", "_", "-"); pass --id.`);
  }
  return name;
}

const sessionList = (plan) => (Array.isArray(plan.sessions) ? plan.sessions.filter((s) => s && typeof s === 'object') : []);
const afterOf = (s) => toArray(s.after).map(String);

// The session's contract object: top-level decisions/context/files first,
// the plan's model/effort/limits as defaults (a session's own limits win per
// key). `id`, `after` and `label` are plan keys, not contract keys.
function sessionBase(r, s) {
  const { id, after, label, ...rest } = s;
  const top = r.plan;
  const base = { ...rest };
  for (const key of ['decisions', 'context', 'files']) {
    const merged = [...toArray(top[key]), ...toArray(rest[key])];
    if (merged.length) base[key] = merged;
  }
  for (const key of ['model', 'effort']) {
    if (base[key] === undefined && top[key] !== undefined) base[key] = top[key];
  }
  if (top.limits && typeof top.limits === 'object' && !Array.isArray(top.limits)) {
    base.limits = { ...top.limits, ...(rest.limits && typeof rest.limits === 'object' ? rest.limits : {}) };
  }
  return base;
}

// Every problem with the plan, one string each ([] = valid). `state` is the
// stored plan state (sessions it already owns are not "taken").
function checkPlan(r, { name, state } = {}) {
  const problems = [];
  const { plan } = r;
  const unknown = Object.keys(plan).filter((k) => !PLAN_KEYS.includes(k));
  if (unknown.length) problems.push(`unknown plan key(s): ${unknown.join(', ')}. Accepted: ${PLAN_KEYS.join(', ')}`);
  if (plan.limits !== undefined && (!plan.limits || typeof plan.limits !== 'object' || Array.isArray(plan.limits))) {
    problems.push('plan "limits" must be an object (timeoutMs, maxRepairs, checkTimeoutMs).');
  }
  if (!Array.isArray(plan.sessions) || plan.sessions.length === 0) {
    problems.push('plan needs a non-empty "sessions" array.');
    return problems;
  }
  try {
    if (!fs.statSync(r.cwd).isDirectory()) throw new Error('not a directory');
  } catch {
    problems.push(`cwd "${r.cwd}" is not an existing directory.`);
    return problems;
  }

  const sessions = plan.sessions;
  const ids = [];
  sessions.forEach((s, i) => {
    if (!s || typeof s !== 'object' || Array.isArray(s)) {
      problems.push(`sessions[${i}] must be an object.`);
      return;
    }
    const label = typeof s.id === 'string' ? `session "${s.id}"` : `sessions[${i}]`;
    if (!store.validId(s.id)) {
      problems.push(`${label}: "id" must be 1-64 chars of letters, digits, ".", "_" or "-", starting with a letter or digit.`);
    } else if (s.id.length + 4 > 64) {
      problems.push(`${label}: id is too long (the preflight session "${s.id}.pre" must fit 64 chars).`);
    } else if (ids.includes(s.id)) {
      problems.push(`duplicate session id "${s.id}".`);
    }
    if (typeof s.id === 'string') ids.push(s.id);
    if (s.label !== undefined && typeof s.label !== 'string') problems.push(`${label}: "label" must be a string.`);
    if (s.after !== undefined && !toArray(s.after).every((a) => typeof a === 'string')) {
      problems.push(`${label}: "after" must be a list of session ids.`);
    }
  });
  const valid = sessionList(plan).filter((s) => typeof s.id === 'string');

  // after refs and cycles
  const known = new Set(valid.map((s) => s.id));
  const deps = new Map(valid.map((s) => [s.id, afterOf(s)]));
  for (const s of valid) {
    for (const a of afterOf(s)) {
      if (a === s.id) problems.push(`session "${s.id}" is after itself.`);
      else if (!known.has(a)) problems.push(`session "${s.id}": after "${a}" is not a session in this plan.`);
    }
  }
  let cyclic = false;
  const mark = new Map();
  const walk = (id, trail) => {
    if (mark.get(id) === 2) return;
    if (mark.get(id) === 1) {
      cyclic = true;
      problems.push(`dependency cycle: ${[...trail.slice(trail.indexOf(id)), id].join(' -> ')}`);
      return;
    }
    mark.set(id, 1);
    for (const a of deps.get(id) || []) if (known.has(a) && a !== id) walk(a, [...trail, id]);
    mark.set(id, 2);
  };
  for (const id of known) if (!cyclic) walk(id, []);

  // contracts, model/effort, ownership
  const contracts = new Map();
  for (const s of valid) {
    let contract;
    try {
      contract = buildContract({ base: sessionBase(r, s), baseDir: r.dir, cwd: r.cwd });
    } catch (err) {
      if (err instanceof ContractError) problems.push(`session "${s.id}": ${err.message}`);
      else throw err;
      continue;
    }
    const model = contract.model === null ? DEFAULT_MODEL : normalizeModel(contract.model);
    if (!model) {
      problems.push(`session "${s.id}": ${unknownModelMessage(contract.model)}`);
    } else {
      const effort = contract.effort === null ? 'max' : normalizeEffort(contract.effort);
      if (!effort) problems.push(`session "${s.id}": contract effort "${contract.effort}" is not valid.`);
      else {
        const p = effortProblem(model, effort, { source: `session "${s.id}" effort` });
        if (p) problems.push(p);
      }
    }
    contracts.set(s.id, contract);
  }

  // Sessions that can run at the same time (neither is, transitively, after
  // the other) must own disjoint paths.
  if (!cyclic) {
    const reach = new Map();
    const closure = (id) => {
      if (reach.has(id)) return reach.get(id);
      const set = new Set();
      reach.set(id, set);
      for (const a of deps.get(id) || []) {
        if (!known.has(a)) continue;
        set.add(a);
        for (const x of closure(a)) set.add(x);
      }
      return set;
    };
    for (const id of known) closure(id);
    let root;
    const owns = new Map();
    for (const [id, c] of contracts) {
      try {
        root = root || workspaceRoot(r.cwd);
        owns.set(id, normalizeOwns(c.owns, r.cwd, root));
      } catch (err) {
        if (err instanceof OwnershipError) problems.push(`session "${id}": ${err.message}`);
        else throw err;
      }
    }
    const order = [...owns.keys()];
    for (let i = 0; i < order.length; i++) {
      for (let j = i + 1; j < order.length; j++) {
        const [a, b] = [order[i], order[j]];
        if (reach.get(a).has(b) || reach.get(b).has(a)) continue;
        if (ownsOverlap(owns.get(a), owns.get(b))) {
          const show = (id) => (contracts.get(id).owns.length ? contracts.get(id).owns.join(', ') : 'whole workspace');
          problems.push(`sessions "${a}" and "${b}" can run concurrently but their owns overlap (${show(a)} / ${show(b)}); add "after" or make owns disjoint.`);
        }
      }
    }
  }

  // Ids already taken by sessions that are not this plan's.
  const mine = new Set(state && Array.isArray(state.sessions) ? state.sessions : []);
  let taken = false;
  for (const id of known) {
    if (store.readSession(id) && !mine.has(id)) {
      taken = true;
      problems.push(`session "${id}" already exists (zcode status ${id}).`);
    }
  }
  if (taken) {
    problems.push(`hint: use a fresh id prefix for a new run (e.g. "<prefix>-<id>"), or "zcode plan resume ${name || '<name>'}" to continue that plan's sessions.`);
  }
  return problems;
}

// --- status, derived from the sessions ------------------------------------------

const LIVE = new Set(['queued', 'running']);
const FINAL_OK = 'completed';

function launchFailure(id, message) {
  return {
    type: 'result', ok: false, status: 'failed', id, kind: 'task',
    error: { kind: 'launch', message }, issues: [message],
  };
}

// {id: {status, view?}} for every session of the plan. A session that was
// never started is `pending`, or `skipped` when something it (transitively)
// depends on ended without completing.
function sessionStatuses(r, state) {
  const out = new Map();
  const sessions = sessionList(r.plan);
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const resolve = (id) => {
    if (out.has(id)) return out.get(id);
    const s = byId.get(id);
    const record = store.readSession(id);
    let entry;
    if (record) {
      const view = store.viewSession(record);
      if (LIVE.has(view.state)) entry = { status: view.state, view };
      else if (view.state === 'interrupted') entry = { status: 'interrupted', view };
      else entry = { status: view.status || 'failed', view };
    } else if (state && state.launchErrors && state.launchErrors[id]) {
      entry = { status: 'failed', launchError: state.launchErrors[id] };
    } else {
      const upstream = afterOf(s).filter((a) => byId.has(a)).map(resolve);
      const dead = upstream.some((u) => !['pending', 'queued', 'running', FINAL_OK].includes(u.status));
      entry = { status: dead ? 'skipped' : 'pending' };
    }
    out.set(id, entry);
    return entry;
  };
  for (const s of sessions) resolve(s.id);
  return out;
}

function aggregate(statuses, supervisorAlive) {
  const all = [...statuses.values()].map((e) => e.status);
  if (all.some((s) => LIVE.has(s))) return 'running';
  if (all.includes('pending')) return supervisorAlive ? 'running' : 'interrupted';
  if (all.every((s) => s === FINAL_OK)) return 'completed';
  if (all.includes('blocked')) return 'blocked';
  if (all.some((s) => ['failed', 'cancelled', 'interrupted'].includes(s))) return 'failed';
  return 'partial';
}

const exitCodeForPlan = (status) => (status === 'completed' ? 0 : status === 'blocked' ? 10 : status === 'running' ? 124 : 8);

function supervisorAlive(state) {
  return Boolean(state && state.supervisor && store.pidAlive(state.supervisor.pid));
}

// {type:"plan", name, status, sessions:[{id,status}], briefs:[…]}: briefs of
// sessions that ended without completing (never for pending/skipped).
function planReport(name, r, state, { briefs = true } = {}) {
  const { finalResult } = require('./commands/sessions.js');
  const statuses = sessionStatuses(r, state);
  const status = aggregate(statuses, supervisorAlive(state));
  const payload = {
    type: 'plan',
    name,
    status,
    sessions: sessionList(r.plan).map((s) => {
      const e = statuses.get(s.id);
      return { id: s.id, status: e.status, ...(e.view ? store.idleInfo(e.view) : null) };
    }),
  };
  if (briefs) {
    payload.briefs = [];
    for (const s of sessionList(r.plan)) {
      const e = statuses.get(s.id);
      if (e.status === FINAL_OK) continue;
      if (e.launchError) payload.briefs.push(buildBrief(launchFailure(s.id, e.launchError)));
      else if (e.view && !LIVE.has(e.view.state)) payload.briefs.push(buildBrief(finalResult(e.view)));
    }
  }
  return payload;
}

// --- launching --------------------------------------------------------------------

function exec() {
  return require('./commands/exec.js');
}

// Preflights run all at once on the current workspace, so a session with
// `after` would see none of its prerequisites' files. This paragraph tells it
// to assume them (ids + clipped objectives) instead of asking about them.
function preflightContext(r, s) {
  const upstream = afterOf(s).map((a) => sessionList(r.plan).find((x) => x.id === a)).filter(Boolean);
  if (!upstream.length) return null;
  const clip = (t) => {
    const x = String(t || '').replace(/\s+/g, ' ').trim();
    return x.length <= 200 ? x : `${x.slice(0, 199)}…`;
  };
  const list = upstream.map((u) => `- ${u.id}: ${clip(sessionBase(r, u).objective) || '(no objective)'}`).join('\n');
  return `This is a plan preflight. Sessions ${upstream.map((u) => u.id).join(', ')} run before you and have not run yet; their files will exist when you execute. Assume they deliver what the binding decisions and their objectives say:\n${list}\nDo not ask about their absence; ask only about what the decisions leave open for YOUR scope.`;
}

// The detached-start invocation for one plan session (id overrides the plan
// id: preflight uses "<id>.pre"). The label is `plan:<name>` plus the
// session's own `label`, if any.
function sessionInvocation(r, name, s, { id = s.id, preflight = false } = {}) {
  const { parseArgv } = require('../bin/zcode.js');
  const label = `plan:${name}${typeof s.label === 'string' && s.label.trim() ? ` ${s.label.trim()}` : ''}`;
  const argv = ['task', '--id', id, '--cwd', r.cwd, '--label', label];
  if (preflight) argv.push('--preflight');
  const base = sessionBase(r, s);
  const note = preflight ? preflightContext(r, s) : null;
  if (note) base.context = [...toArray(base.context), note];
  return exec().buildInvocation(parseArgv(argv), { base, dir: r.dir });
}

function launchSession(r, name, s) {
  const e = exec();
  try {
    e.startDetached(sessionInvocation(r, name, s));
    return null;
  } catch (err) {
    if (err instanceof store.SessionExistsError) return null; // already started
    if (err instanceof e.UsageError || err instanceof ContractError || err.exitCode) return err.message;
    throw err;
  }
}

// Resume one session of the plan (detached). Returns null or the refusal.
function resumeSession(id, message) {
  const { parseArgv } = require('../bin/zcode.js');
  const e = exec();
  try {
    e.startDetached(e.buildResume(parseArgv(['resume', id]), id, message));
    return null;
  } catch (err) {
    if (err instanceof e.UsageError || err.exitCode) return err.message;
    throw err;
  }
}

// --- supervisor ---------------------------------------------------------------------

// Launches ready sessions until nothing is running or launchable. One
// supervisor per plan (pid lock). Returns {done:true} | {timedOut:true} |
// {busy:true} (another supervisor holds the plan).
async function supervise(name, { deadline = Infinity, signal } = {}) {
  const release = store.claimPlan(name);
  if (!release) return { busy: true };
  try {
    store.updatePlanState(name, { supervisor: { pid: process.pid } });
    for (;;) {
      const state = store.readPlanState(name);
      const r = resolvePlan(state.file, state.cwd);
      const sessions = sessionList(r.plan);
      const byId = new Map(sessions.map((s) => [s.id, s]));
      const statuses = sessionStatuses(r, state);
      for (const s of sessions) {
        if (statuses.get(s.id).status !== 'pending') continue;
        if (!afterOf(s).every((a) => statuses.get(a) && statuses.get(a).status === FINAL_OK)) continue;
        const failure = launchSession(r, name, byId.get(s.id));
        if (failure) {
          store.updatePlanState(name, (cur) => ({ launchErrors: { ...(cur.launchErrors || {}), [s.id]: failure } }));
        }
      }
      const now = sessionStatuses(r, store.readPlanState(name));
      const active = [...now.values()].some((e) => LIVE.has(e.status) || e.status === 'pending');
      if (!active) return { done: true };
      if (signal && signal.aborted) return { done: true };
      if (Date.now() >= deadline) return { timedOut: true };
      await sleep(POLL_MS);
    }
  } finally {
    try {
      store.updatePlanState(name, { supervisor: null });
    } catch {
      /* plan state removed */
    }
    release();
  }
}

// A detached supervisor process (`zcode __plan <name>`); records its pid.
function startSupervisor(name) {
  const dir = store.plansDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const log = fs.openSync(path.join(dir, `${name}.log`), 'a', 0o600);
  const child = spawn(process.execPath, [BIN, '__plan', name], {
    detached: true,
    stdio: ['ignore', log, log],
    env: process.env,
  });
  child.unref();
  fs.closeSync(log);
  store.updatePlanState(name, { supervisor: { pid: child.pid } });
  return child.pid;
}

module.exports = {
  PlanError,
  resolvePlan,
  planName,
  sessionList,
  afterOf,
  sessionBase,
  checkPlan,
  sessionStatuses,
  aggregate,
  exitCodeForPlan,
  supervisorAlive,
  planReport,
  launchFailure,
  sessionInvocation,
  preflightContext,
  launchSession,
  resumeSession,
  supervise,
  startSupervisor,
  sleep,
  POLL_MS,
};

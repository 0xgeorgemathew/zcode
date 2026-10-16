'use strict';
// Session store: one directory per zcode session under <root>/sessions/<id>.
//
//   session.json   lifecycle record (atomic tmp+rename writes; the owning
//                  process is the only writer while it is alive)
//   events.ndjson  bounded activity log (phases, tools, checks — no deltas)
//   result.json    the final handback of the latest invocation
//   home/          the session's own engine HOME (engine DB, subagent dirs)
//   pending.json   a detached invocation waiting for its worker
//   stdout.ndjson / stderr.log   output of detached workers
//
// Lifecycle: queued → running → finished (status: completed | unverified |
// partial | blocked | failed | cancelled). A record that says queued/running
// whose pid is gone reads as "interrupted" — resumable, never silently
// "running" forever.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { rootDir } = require('./isolation.js');

const RECORD_SCHEMA = 'zcode.session/1';
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_EVENTS = 2000;
const ACTIVE_STATES = new Set(['queued', 'running']);

class SessionExistsError extends Error {
  constructor(id) {
    super(
      `session "${id}" already exists. Inspect it with "zcode status ${id}" ` +
        `or continue it with "zcode resume ${id}".`
    );
    this.code = 'ZCODE_SESSION_EXISTS';
  }
}

function sessionsDir(env = process.env) {
  return path.join(rootDir(env), 'sessions');
}

function sessionDir(id, env = process.env) {
  return path.join(sessionsDir(env), id);
}

function validId(id) {
  return typeof id === 'string' && ID_RE.test(id);
}

function newId() {
  return `zc-${crypto.randomBytes(4).toString('hex')}`;
}

function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// Claims the id atomically (mkdir fails if it exists) and writes the first
// record. Throws SessionExistsError on collision — an orchestrator retrying
// a start with the same --id never runs the work twice.
function createSession(id, fields, env = process.env) {
  fs.mkdirSync(sessionsDir(env), { recursive: true, mode: 0o700 });
  const dir = sessionDir(id, env);
  try {
    fs.mkdirSync(dir, { mode: 0o700 });
  } catch (err) {
    if (err.code === 'EEXIST') throw new SessionExistsError(id);
    throw err;
  }
  const now = new Date().toISOString();
  const record = {
    schema: RECORD_SCHEMA,
    id,
    createdAt: now,
    updatedAt: now,
    state: 'queued',
    status: null,
    phase: 'queued',
    pid: process.pid,
    turns: 0,
    activity: { toolCalls: 0, subagentsStarted: 0, lastTool: null, lastEventAt: now },
    ...fields,
  };
  writeJsonAtomic(path.join(dir, 'session.json'), record);
  return record;
}

function readSession(id, env = process.env) {
  if (!validId(id)) return null;
  return readJson(path.join(sessionDir(id, env), 'session.json'));
}

// Read-modify-write; `patch` is an object or (record) => object.
function updateSession(id, patch, env = process.env) {
  const file = path.join(sessionDir(id, env), 'session.json');
  const current = readJson(file);
  if (!current) throw new Error(`session "${id}" has no record`);
  const delta = typeof patch === 'function' ? patch(current) : patch;
  const next = { ...current, ...delta, updatedAt: new Date().toISOString() };
  writeJsonAtomic(file, next);
  return next;
}

function deleteSession(id, env = process.env) {
  if (!validId(id)) return;
  fs.rmSync(sessionDir(id, env), { recursive: true, force: true });
}

function writeResult(id, result, env = process.env) {
  writeJsonAtomic(path.join(sessionDir(id, env), 'result.json'), result);
}

function readResult(id, env = process.env) {
  if (!validId(id)) return null;
  return readJson(path.join(sessionDir(id, env), 'result.json'));
}

// Bounded append-only activity log. Counting lines once per process keeps
// appends O(1).
const eventCounts = new Map();
function appendEvent(id, event, env = process.env) {
  const file = path.join(sessionDir(id, env), 'events.ndjson');
  let count = eventCounts.get(file);
  if (count === undefined) {
    try {
      count = fs.readFileSync(file, 'utf8').split('\n').length - 1;
    } catch {
      count = 0;
    }
  }
  if (count >= MAX_EVENTS && event.type !== 'phase' && event.type !== 'result') return;
  fs.appendFileSync(file, JSON.stringify({ t: new Date().toISOString(), ...event }) + '\n', {
    mode: 0o600,
  });
  eventCounts.set(file, count + 1);
}

function readEvents(id, { tail = 20 } = {}, env = process.env) {
  try {
    const lines = fs
      .readFileSync(path.join(sessionDir(id, env), 'events.ndjson'), 'utf8')
      .split('\n')
      .filter(Boolean);
    return lines.slice(-tail).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

// The record as callers should see it: an active state whose owner process
// is gone is reported as "interrupted".
function viewSession(record) {
  if (!record) return null;
  if (ACTIVE_STATES.has(record.state) && !pidAlive(record.pid)) {
    return { ...record, state: 'interrupted', live: false };
  }
  return { ...record, live: ACTIVE_STATES.has(record.state) };
}

function listSessions(env = process.env) {
  let names = [];
  try {
    names = fs.readdirSync(sessionsDir(env));
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    const record = readSession(name, env);
    if (record) out.push(viewSession(record));
  }
  return out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

// Accepts a zcode id or an engine session id (sess_…, as printed by 0.3.x
// and still reported as result.sessionId). Returns the zcode id or null.
function resolveSessionId(ref, env = process.env) {
  if (validId(ref) && readSession(ref, env)) return ref;
  for (const record of listSessions(env)) {
    if (record.engineSessionId === ref) return record.id;
  }
  return null;
}

// Exclusive pid lock (O_EXCL create). A lock whose pid is dead is stale and
// reclaimed; the content is re-read just before removal so a fresh lock
// taken by a racing reclaimer is not deleted. Returns release() or null.
function claimLockFile(file) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fs.writeFileSync(file, String(process.pid), { flag: 'wx', mode: 0o600 });
      return () => {
        try {
          if (fs.readFileSync(file, 'utf8') === String(process.pid)) fs.rmSync(file, { force: true });
        } catch {
          /* already gone */
        }
      };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    let holder;
    try {
      holder = fs.readFileSync(file, 'utf8');
    } catch {
      continue; // released in between: retry the create
    }
    if (pidAlive(Number(holder))) return null;
    try {
      if (fs.readFileSync(file, 'utf8') === holder) fs.rmSync(file, { force: true });
    } catch {
      /* someone else reclaimed it */
    }
  }
  return null;
}

// One live process drives a session at a time (two racing `resume`s, or a
// resume racing a detached worker, cannot both run it).
function claimSession(id, env = process.env) {
  return claimLockFile(path.join(sessionDir(id, env), 'owner.lock'));
}

// Machine-wide soft cap on running sessions (ZAI_CODE_MAX_ACTIVE): N slot
// lock files; a session holds one while it runs.
function claimSlot(max, env = process.env) {
  const dir = path.join(rootDir(env), 'slots');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (let n = 0; n < max; n++) {
    const release = claimLockFile(path.join(dir, `${n}.lock`));
    if (release) return release;
  }
  return null;
}

module.exports = {
  RECORD_SCHEMA,
  SessionExistsError,
  sessionsDir,
  sessionDir,
  validId,
  newId,
  createSession,
  readSession,
  updateSession,
  deleteSession,
  writeResult,
  readResult,
  appendEvent,
  readEvents,
  pidAlive,
  viewSession,
  listSessions,
  resolveSessionId,
  claimSession,
  claimSlot,
  claimLockFile,
  writeJsonAtomic,
};

'use strict';
// Workspace boundaries for concurrent sessions:
//  - ownership: `--owns` patterns (paths or globs, relative to --cwd) name
//    what a session may modify; none = the whole workspace.
//  - leases: a live session registers its ownership under
//    <root>/leases/<workspace>/; a new session whose ownership overlaps a
//    live one is refused (exit 7) unless --allow-overlap.
//  - change tracking: a snapshot before and after the work yields the files
//    the session changed (git status + content hashes in a git repo, a
//    bounded mtime walk otherwise) and the ones outside its ownership.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { rootDir } = require('./isolation.js');
const { pidAlive } = require('./store.js');

class OwnershipError extends Error {}

const toPosix = (p) => p.split(path.sep).join('/');

function gitToplevel(cwd) {
  try {
    return execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    }).trim();
  } catch {
    return null;
  }
}

// The lease/change-tracking root: the git toplevel when --cwd is inside a
// repo (so sessions in sibling subdirectories still see each other), else
// the real --cwd.
function workspaceRoot(cwd) {
  const real = fs.realpathSync(cwd);
  const top = gitToplevel(real);
  return top ? fs.realpathSync(top) : real;
}

// Ownership patterns arrive relative to --cwd; store them relative to the
// workspace root, posix-style, so every session compares like with like.
function normalizeOwns(patterns, cwd, root, flag = '--owns') {
  const realCwd = fs.realpathSync(cwd);
  return patterns.map((raw) => {
    const pattern = String(raw).trim();
    if (!pattern) throw new OwnershipError(`${flag} pattern must not be empty`);
    const abs = path.isAbsolute(pattern) ? pattern : path.join(realCwd, pattern);
    const rel = toPosix(path.relative(root, abs));
    if (rel === '' || rel === '.') return '**';
    if (rel.startsWith('../') || rel === '..' || path.isAbsolute(rel)) {
      throw new OwnershipError(`${flag} "${pattern}" is outside the workspace ${root}`);
    }
    return /[/\\]$/.test(pattern) && !hasWildcard(rel) ? `${rel}/**` : rel;
  });
}

function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else {
          re += '.*';
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

const hasWildcard = (p) => /[*?]/.test(p);

// A plain path owns itself and everything beneath it; a glob owns its
// matches. Empty ownership = the whole workspace.
function isOwned(relPath, owns) {
  if (!owns || owns.length === 0) return true;
  return owns.some((pattern) => {
    if (!hasWildcard(pattern)) return relPath === pattern || relPath.startsWith(`${pattern}/`);
    return globToRegExp(pattern).test(relPath);
  });
}

// The literal directory part of a pattern (segments before the first
// wildcard). Overlap is decided conservatively on these prefixes: two
// patterns overlap when one prefix contains the other.
function staticSegments(pattern) {
  const out = [];
  for (const seg of pattern.split('/')) {
    if (hasWildcard(seg)) break;
    out.push(seg);
  }
  return out;
}

function patternsOverlap(a, b) {
  const sa = staticSegments(a);
  const sb = staticSegments(b);
  const n = Math.min(sa.length, sb.length);
  for (let i = 0; i < n; i++) if (sa[i] !== sb[i]) return false;
  // Same literal prefix. Two fully literal, distinct paths of equal depth
  // were already ruled out above; anything else may share files.
  return true;
}

function ownsOverlap(a, b) {
  if (!a || !b || a.length === 0 || b.length === 0) return true;
  return a.some((pa) => b.some((pb) => patternsOverlap(pa, pb)));
}

// --- leases -------------------------------------------------------------------

function leaseDir(root, env = process.env) {
  const key = crypto.createHash('sha256').update(root).digest('hex').slice(0, 16);
  return path.join(rootDir(env), 'leases', key);
}

function readLeases(dir) {
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    try {
      out.push(JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')));
    } catch {
      /* half-written or removed concurrently */
    }
  }
  return out;
}

// Registers this session's lease, then compares against every other live
// lease. Writing first and reading second means two sessions starting at
// the same instant both see each other; the later (startedAt, id) backs
// off, so exactly one proceeds.
function acquireLease({ id, root, owns, touch = [], allowOverlap = false, env = process.env }) {
  const dir = leaseDir(root, env);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const mine = { id, pid: process.pid, root, owns, touch, startedAt: Date.now() };
  const file = path.join(dir, `${id}.json`);
  fs.writeFileSync(file, JSON.stringify(mine) + '\n', { mode: 0o600 });

  const others = [];
  for (const lease of readLeases(dir)) {
    if (!lease || lease.id === id) continue;
    if (!pidAlive(lease.pid)) {
      fs.rmSync(path.join(dir, `${lease.id}.json`), { force: true });
      continue;
    }
    others.push(lease);
  }
  // --touch never reserves anything, but it may not edit what a live
  // session owns (an empty ownership is the whole workspace). Not ordered by
  // start time: the toucher is the one that has to step aside.
  const touchConflicts = touch.length && !allowOverlap ? others.filter((o) => ownsOverlap(touch, o.owns)) : [];
  if (touchConflicts.length) {
    fs.rmSync(file, { force: true });
    return { ok: false, conflicts: touchConflicts, others, touch: true };
  }
  const conflicts = others.filter((o) => ownsOverlap(owns, o.owns));
  const blocking = conflicts.filter(
    (o) => o.startedAt < mine.startedAt || (o.startedAt === mine.startedAt && o.id < id)
  );
  if (blocking.length > 0 && !allowOverlap) {
    fs.rmSync(file, { force: true });
    return { ok: false, conflicts: blocking, others };
  }
  return { ok: true, conflicts, others, release: () => fs.rmSync(file, { force: true }) };
}

function liveLeases(root, env = process.env) {
  return readLeases(leaseDir(root, env)).filter((l) => l && pidAlive(l.pid));
}

// --- change tracking ----------------------------------------------------------

// zcode's own per-session directories (<cwd>/.zcode/out/<id>, project skills)
// are never changes of the task, at any depth. The Playwright MCP's scratch
// dir (.playwright-mcp: console logs, page snapshots) written by --visual
// verification is tooling output, not task output.
const TOOL_DIRS = new Set(['.zcode', '.playwright-mcp']);
const isZcodePath = (rel) => rel.split('/').some((seg) => TOOL_DIRS.has(seg));

const WALK_SKIP = new Set(['.git', 'node_modules', '.zcode', '.playwright-mcp', '.DS_Store']);
const WALK_LIMIT = 20000;
const HASH_LIMIT = 8 * 1024 * 1024;

function fileSignature(abs) {
  try {
    const st = fs.statSync(abs);
    if (!st.isFile()) return `other:${st.mtimeMs}`;
    if (st.size > HASH_LIMIT) return `big:${st.size}:${st.mtimeMs}`;
    return crypto.createHash('sha1').update(fs.readFileSync(abs)).digest('hex');
  } catch {
    return 'missing';
  }
}

// Parses `git status --porcelain=v1 -z`; rename/copy entries carry the
// source path as an extra NUL field.
function gitStatus(root) {
  const raw = execFileSync(
    'git',
    ['-C', root, 'status', '--porcelain=v1', '-z', '--untracked-files=all'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000, maxBuffer: 64 * 1024 * 1024 }
  );
  const fields = raw.split('\0');
  const out = new Map();
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    if (f.length < 4) continue;
    const code = f.slice(0, 2);
    out.set(f.slice(3), code);
    if (code[0] === 'R' || code[0] === 'C') i++;
  }
  return out;
}

function gitHead(root) {
  try {
    return execFileSync('git', ['-C', root, 'rev-parse', '--verify', '-q', 'HEAD'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000,
    }).trim() || null;
  } catch {
    return null;
  }
}

// Files changed between two commits (the executor committed, stashed or
// checked out): without this, committed work would vanish from the diff.
function committedChanges(root, from, to) {
  try {
    const raw = execFileSync('git', ['-C', root, 'diff', '--name-status', '-z', '--no-renames', from, to], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000, maxBuffer: 64 * 1024 * 1024,
    });
    const f = raw.split('\0');
    const out = [];
    for (let i = 0; i + 1 < f.length; i += 2) {
      if (!f[i]) break;
      const change = f[i][0] === 'A' ? 'added' : f[i][0] === 'D' ? 'deleted' : 'modified';
      out.push({ path: f[i + 1], change });
    }
    return out;
  } catch {
    return [];
  }
}

function snapshot(root) {
  if (gitToplevel(root)) {
    try {
      const entries = new Map();
      for (const [rel, code] of gitStatus(root)) {
        if (isZcodePath(rel)) continue;
        entries.set(rel, { code, sig: fileSignature(path.join(root, rel)) });
      }
      return { kind: 'git', root, head: gitHead(root), entries };
    } catch {
      /* fall back to the walk */
    }
  }
  const entries = new Map();
  const stack = [''];
  while (stack.length) {
    const rel = stack.pop();
    let dirents;
    try {
      dirents = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of dirents) {
      if (WALK_SKIP.has(d.name)) continue;
      const childRel = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) stack.push(childRel);
      else if (d.isFile()) {
        if (entries.size >= WALK_LIMIT) return { kind: 'unavailable', entries: null };
        try {
          const st = fs.statSync(path.join(root, childRel));
          entries.set(childRel, { code: 'fs', sig: `${st.size}:${st.mtimeMs}` });
        } catch {
          /* vanished mid-walk */
        }
      }
    }
  }
  return { kind: 'fs', entries };
}

// Files whose state differs between two snapshots. In git mode a path
// absent from `after` but present in `before` went back to clean — it was
// still changed by someone.
function diffSnapshots(before, after) {
  if (!before || !after || !before.entries || !after.entries || before.kind !== after.kind) {
    return null;
  }
  const out = [];
  const paths = new Set([...before.entries.keys(), ...after.entries.keys()]);
  for (const rel of [...paths].sort()) {
    const b = before.entries.get(rel);
    const a = after.entries.get(rel);
    if (b && a && b.sig === a.sig && b.code === a.code) continue;
    let change = 'modified';
    if (after.kind === 'fs') {
      if (!b) change = 'added';
      else if (!a) change = 'deleted';
    } else if (a) {
      if (a.code.includes('D') || a.sig === 'missing') change = 'deleted';
      else if (!b && (a.code === '??' || a.code[0] === 'A')) change = 'added';
    }
    out.push({ path: rel, change });
  }
  if (after.kind === 'git' && before.head && after.head && before.head !== after.head) {
    const seen = new Set(out.map((f) => f.path));
    for (const f of committedChanges(after.root, before.head, after.head)) {
      if (!seen.has(f.path) && !isZcodePath(f.path)) out.push({ ...f, committed: true });
    }
    out.sort((a, b) => a.path.localeCompare(b.path));
  }
  return out;
}

// Keeps zcode's own scratch dirs out of the target repo's `git status`:
// appends missing entries to the repo-local exclude file (never .gitignore;
// `--git-path info/exclude` also resolves for worktrees). Idempotent,
// append-only, silent: every error is ignored.
const LOCAL_EXCLUDES = ['.zcode/', '.playwright-mcp/'];
function ensureLocalExclude(cwd) {
  try {
    const rel = execFileSync('git', ['-C', cwd, 'rev-parse', '--git-path', 'info/exclude'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!rel) return;
    const file = path.resolve(cwd, rel);
    let text = '';
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      /* no exclude file yet */
    }
    const have = new Set(text.split(/\r?\n/).map((l) => l.trim().replace(/^\//, '').replace(/\/$/, '')));
    const missing = LOCAL_EXCLUDES.filter((e) => !have.has(e.replace(/\/$/, '')));
    if (!missing.length) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${text && !text.endsWith('\n') ? '\n' : ''}${missing.join('\n')}\n`);
  } catch {
    /* hygiene is best-effort */
  }
}

module.exports = {
  ensureLocalExclude,
  OwnershipError,
  workspaceRoot,
  normalizeOwns,
  globToRegExp,
  isOwned,
  isZcodePath,
  ownsOverlap,
  acquireLease,
  liveLeases,
  leaseDir,
  snapshot,
  diffSnapshots,
};

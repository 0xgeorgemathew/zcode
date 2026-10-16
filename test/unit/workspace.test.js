'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const ws = require('../../lib/workspace.js');

let base;
before(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-ws-')));
  process.env.ZAI_CODE_HOME = path.join(base, 'root');
});
after(() => fs.rmSync(base, { recursive: true, force: true }));

test('isOwned: plain paths own their subtree, globs their matches, none = everything', () => {
  assert.ok(ws.isOwned('src/pages/p1/a.tsx', ['src/pages/p1']));
  assert.ok(!ws.isOwned('src/pages/p10/a.tsx', ['src/pages/p1']));
  assert.ok(ws.isOwned('src/pages/p1/x/y.css', ['src/pages/p1/**']));
  assert.ok(ws.isOwned('src/a.css', ['src/**/*.css']));
  assert.ok(ws.isOwned('src/deep/a.css', ['src/**/*.css']));
  assert.ok(!ws.isOwned('src/a.ts', ['src/*.css']));
  assert.ok(ws.isOwned('anything', []));
});

test('ownsOverlap: disjoint page dirs do not overlap; nesting and whole-workspace do', () => {
  assert.equal(ws.ownsOverlap(['src/pages/p1/**'], ['src/pages/p2/**']), false);
  assert.equal(ws.ownsOverlap(['src/a.ts'], ['src/b.ts']), false);
  assert.equal(ws.ownsOverlap(['src/**'], ['src/pages/p2/**']), true);
  assert.equal(ws.ownsOverlap(['src/**/*.css'], ['src/pages/**']), true, 'conservative on wildcards');
  assert.equal(ws.ownsOverlap([], ['docs/**']), true);
});

test('normalizeOwns: relative to --cwd, stored relative to the workspace root, never outside it', () => {
  const root = path.join(base, 'norm');
  fs.mkdirSync(path.join(root, 'web'), { recursive: true });
  assert.deepEqual(ws.normalizeOwns(['pages/p1/**', 'lib/'], path.join(root, 'web'), root), ['web/pages/p1/**', 'web/lib/**']);
  assert.deepEqual(ws.normalizeOwns(['.'], root, root), ['**']);
  assert.throws(() => ws.normalizeOwns(['../elsewhere'], root, root), ws.OwnershipError);
});

test('git snapshot diff: added, modified (incl. already-dirty), deleted, renamed; root is the toplevel', () => {
  const repo = path.join(base, 'repo');
  fs.mkdirSync(path.join(repo, 'sub'), { recursive: true });
  const git = (...a) => execFileSync('git', ['-C', repo, ...a], { stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  fs.writeFileSync(path.join(repo, 'keep.txt'), '1');
  fs.writeFileSync(path.join(repo, 'gone.txt'), '1');
  fs.writeFileSync(path.join(repo, 'dirty.txt'), '1');
  fs.writeFileSync(path.join(repo, 'old.txt'), 'o');
  git('add', '.');
  git('commit', '-qm', 'init');
  fs.writeFileSync(path.join(repo, 'dirty.txt'), '2'); // dirty before the session

  assert.equal(ws.workspaceRoot(path.join(repo, 'sub')), fs.realpathSync(repo));
  const before = ws.snapshot(repo);
  assert.equal(before.kind, 'git');
  fs.writeFileSync(path.join(repo, 'dirty.txt'), '3');
  fs.writeFileSync(path.join(repo, 'sub', 'new.txt'), 'n');
  fs.rmSync(path.join(repo, 'gone.txt'));
  git('mv', 'old.txt', 'renamed.txt');
  const diff = ws.diffSnapshots(before, ws.snapshot(repo));
  const byPath = Object.fromEntries(diff.map((d) => [d.path, d.change]));
  assert.equal(byPath['dirty.txt'], 'modified');
  assert.equal(byPath['sub/new.txt'], 'added');
  assert.equal(byPath['gone.txt'], 'deleted');
  assert.ok(byPath['renamed.txt'], 'rename target reported');
  assert.equal(byPath['keep.txt'], undefined);

  // Work the executor committed does not vanish from the diff.
  const before2 = ws.snapshot(repo);
  fs.writeFileSync(path.join(repo, 'committed.txt'), 'c');
  git('add', '-A');
  git('commit', '-qm', 'executor commit');
  const diff2 = ws.diffSnapshots(before2, ws.snapshot(repo));
  assert.ok(diff2.some((d) => d.path === 'committed.txt' && d.change === 'added' && d.committed));
});

test('fs snapshot diff (no git)', () => {
  const dir = path.join(base, 'plain');
  fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
  const before = ws.snapshot(dir);
  assert.equal(before.kind, 'fs');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'b');
  fs.writeFileSync(path.join(dir, 'node_modules', 'ignored.js'), 'x');
  fs.rmSync(path.join(dir, 'a.txt'));
  assert.deepEqual(ws.diffSnapshots(before, ws.snapshot(dir)), [
    { path: 'a.txt', change: 'deleted' },
    { path: 'b.txt', change: 'added' },
  ]);
});

test('leases: overlap refused, disjoint allowed, stale leases reaped, --allow-overlap honored', async () => {
  const root = path.join(base, 'leases');
  const a = ws.acquireLease({ id: 'a', root, owns: ['src/p1/**'] });
  assert.ok(a.ok);
  const b = ws.acquireLease({ id: 'b', root, owns: ['src/p2/**'] });
  assert.ok(b.ok, 'disjoint ownership coexists');
  const c = ws.acquireLease({ id: 'c', root, owns: [] });
  assert.equal(c.ok, false, 'whole-workspace overlaps everything');
  assert.deepEqual(c.conflicts.map((x) => x.id).sort(), ['a', 'b']);
  const d = ws.acquireLease({ id: 'd', root, owns: [], allowOverlap: true });
  assert.ok(d.ok);
  d.release();

  // A lease whose process died is reaped, not a conflict forever.
  const dead = spawn(process.execPath, ['-e', '']);
  await new Promise((r) => dead.on('exit', r));
  fs.writeFileSync(path.join(ws.leaseDir(root), 'ghost.json'), JSON.stringify({ id: 'ghost', pid: dead.pid, owns: [], startedAt: 1 }));
  a.release();
  b.release();
  const e = ws.acquireLease({ id: 'e', root, owns: [] });
  assert.ok(e.ok, 'stale lease does not block');
  assert.ok(!fs.existsSync(path.join(ws.leaseDir(root), 'ghost.json')));
  e.release();
});

test('isZcodePath: .zcode and Playwright MCP scratch dirs are tooling output, not task changes', () => {
  assert.ok(ws.isZcodePath('.zcode/out/a/shots/x.png'));
  assert.ok(ws.isZcodePath('.playwright-mcp/page-1.yml'));
  assert.ok(ws.isZcodePath('app/.playwright-mcp/console.log'));
  assert.ok(!ws.isZcodePath('src/playwright-mcp.js'));
});

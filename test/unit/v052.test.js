'use strict';
// v0.5.2: smaller briefs, plan @file fallback/label/limits/hint, preflight
// context for downstream sessions, timeout message and usage accounting,
// local git exclude, per-command help, status listing.
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { cli } = require('../helpers/env.js');
const { setupFake, invocation } = require('../helpers/fake.js');
const { buildBrief } = require('../../lib/brief.js');
const { execute } = require('../../lib/executor.js');
const store = require('../../lib/store.js');
const plans = require('../../lib/plan.js');
const { buildContract } = require('../../lib/taskspec.js');
const { ContractError } = require('../../lib/contract.js');
const { ensureLocalExclude } = require('../../lib/workspace.js');

let fake;
beforeEach(() => {
  fake = setupFake();
});
afterEach(() => fake.cleanup());

const run = (args, opts = {}) => cli(args, { cwd: fake.work, timeoutMs: 60000, ...opts });

// --- 1. briefs ---------------------------------------------------------------------

test('brief: met visual criteria, passing checks and surplus decisions/files collapse to counts and caps', () => {
  const long = 'x'.repeat(400);
  const decisions = Array.from({ length: 9 }, (_, i) => ({ what: `${i}${long}`, why: long }));
  const files = Array.from({ length: 45 }, (_, i) => ({ path: `f${i}.txt`, change: 'added' }));
  files.push({ path: 'theirs.txt', change: 'added', concurrentSession: 'other' });
  const b = buildBrief({
    status: 'completed', ok: true, id: 'x', kind: 'task',
    checks: [{ command: 'a', ok: true }, { command: 'b', ok: true }, { command: 'c', ok: false, exitCode: 1, output: 'no' }],
    visual: [
      { criterion: 'one', viewport: '390x844', met: true, note: 'ok', shot: 's1.png' },
      { criterion: long, viewport: '1440x900', met: false, note: long, shot: 's2.png' },
    ],
    decisions,
    changes: { files },
    questions: [{ q: 'pick', options: [long, 'B'] }],
  });
  assert.equal(b.checks.length, 1);
  assert.equal(b.checksPassed, 2);
  assert.equal(b.visual.length, 1);
  assert.equal(b.visual[0].met, false);
  assert.equal(b.visual[0].criterion.length, 160);
  assert.equal(b.visual[0].note.length, 300);
  assert.equal(b.visualMet, '1/2');
  assert.equal(b.decisions.length, 6);
  assert.equal(b.decisions[0].what.length, 160);
  assert.equal(b.decisions[0].why.length, 120);
  assert.equal(b.decisionsMore, 3);
  assert.equal(b.files.length, 40);
  assert.equal(b.filesMore, 5);
  assert.ok(!b.files.includes('theirs.txt'));
  assert.equal(b.questions[0].options[0].length, 300);
  assert.equal(b.questions[0].options[1], 'B');
  assert.ok(!('checksPassed' in buildBrief({ status: 'failed', id: 'y', checks: [] })));
});

// --- 2. plan -------------------------------------------------------------------------

test('@file in contracts: next to the file first, then --cwd; the error names both paths', () => {
  const dir = path.join(fake.base, 'plans');
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(fake.work, 'docs'));
  fs.writeFileSync(path.join(fake.work, 'docs', 'd.md'), 'FROM CWD');
  const c = buildContract({ base: { objective: 'O', decisions: ['@docs/d.md'] }, baseDir: dir, cwd: fake.work });
  assert.deepEqual(c.decisions, ['FROM CWD']);
  assert.throws(
    () => buildContract({ base: { objective: 'O', decisions: ['@nope.md'] }, baseDir: dir, cwd: fake.work }),
    (err) => err instanceof ContractError && err.message.includes(path.join(dir, 'nope.md')) && err.message.includes(path.join(fake.work, 'nope.md'))
  );
});

const writePlan = (plan) => {
  const file = path.join(fake.work, 'p.json');
  fs.writeFileSync(file, JSON.stringify(plan));
  return plans.resolvePlan(file, fake.work);
};

test('plan: label becomes part of the session label, limits default per key, bad limits refused', () => {
  const r = writePlan({
    limits: { timeoutMs: 5000, maxRepairs: 1 },
    sessions: [
      { id: 'a', label: 'landing', objective: 'A', owns: ['a/**'], limits: { maxRepairs: 3 } },
      { id: 'b', objective: 'B', owns: ['b/**'] },
    ],
  });
  assert.deepEqual(plans.checkPlan(r, { name: 'p' }), []);
  const [a, b] = r.plan.sessions;
  assert.equal(plans.sessionBase(r, a).label, undefined);
  assert.deepEqual(plans.sessionBase(r, a).limits, { timeoutMs: 5000, maxRepairs: 3 });
  assert.deepEqual(plans.sessionBase(r, b).limits, { timeoutMs: 5000, maxRepairs: 1 });
  assert.equal(plans.sessionInvocation(r, 'p', a).label, 'plan:p landing');
  assert.equal(plans.sessionInvocation(r, 'p', a).timeoutMs, 5000);
  assert.equal(plans.sessionInvocation(r, 'p', b).label, 'plan:p');
  assert.equal(plans.sessionInvocation(r, 'p', b).maxRepairs, 1);
  const bad = writePlan({ limits: { nope: 1 }, sessions: [{ id: 'a', objective: 'A' }] });
  assert.ok(plans.checkPlan(bad, { name: 'p' }).some((p) => /unknown limits key/.test(p)));
});

test('plan: taken ids give one line each and ONE trailing hint', () => {
  store.createSession('t1', { kind: 'task', cwd: fake.work });
  store.createSession('t2', { kind: 'task', cwd: fake.work });
  const r = writePlan({ sessions: [{ id: 't1', objective: 'A', owns: ['a/**'] }, { id: 't2', objective: 'B', owns: ['b/**'] }] });
  const problems = plans.checkPlan(r, { name: 'pl' });
  assert.equal(problems.filter((p) => /already exists/.test(p)).length, 2);
  const hints = problems.filter((p) => /^hint: use a fresh id prefix/.test(p));
  assert.equal(hints.length, 1);
  assert.match(hints[0], /zcode plan resume pl/);
});

// --- 6. preflight context ---------------------------------------------------------------

test('plan preflight: sessions with `after` get the upstream paragraph; nothing else changes', () => {
  const r = writePlan({
    sessions: [
      { id: 'up', objective: 'Build the foundation '.repeat(30), owns: ['u/**'] },
      { id: 'down', objective: 'Build the page', owns: ['d/**'], after: ['up'], context: ['mine'] },
    ],
  });
  const [up, down] = r.plan.sessions;
  const pre = plans.sessionInvocation(r, 'p', down, { id: 'down.pre', preflight: true });
  const text = pre.contract.context.join('\n');
  assert.match(text, /This is a plan preflight\. Sessions up run before you and have not run yet/);
  assert.match(text, /- up: Build the foundation/);
  assert.ok(!text.includes('Build the foundation '.repeat(15)), 'objective clipped to 200');
  assert.match(text, /Do not ask about their absence/);
  assert.ok(pre.contract.context.includes('mine'));
  // Real run of the same session, and a session without `after`: unchanged.
  assert.ok(!plans.sessionInvocation(r, 'p', down).contract.context.join('\n').includes('plan preflight'));
  assert.ok(!plans.sessionInvocation(r, 'p', up, { id: 'up.pre', preflight: true }).contract.context.join('\n').includes('plan preflight'));
});

// --- 3. timeout and usage ------------------------------------------------------------------

test('timeout: message tells how to resume; failed turn keeps its model-request count; usageTotal accumulates', async () => {
  fake.setScript({ turns: [{ hang: true }, { hang: true }, { response: 'ok' }] });
  const r = await execute(invocation(fake, { id: 'to-1', timeoutMs: 600, label: 'plan:wcplan' }));
  assert.equal(r.error.kind, 'timeout');
  assert.match(r.error.message, /^timed out after \d+ min; "zcode plan resume wcplan "continue"" picks up from the current files$/);
  assert.equal(r.usage.modelRequests, 1);
  assert.equal(r.usage.incomplete, true);
  assert.deepEqual(r.usageTotal, { inputTokens: 0, outputTokens: 0, modelRequests: 1 });
  assert.ok(!('usage' in buildBrief(r)));

  const plain = await execute(invocation(fake, { id: 'to-2', timeoutMs: 600, kind: 'run' }));
  assert.match(plain.error.message, /"zcode resume to-2 "continue""/);

  const again = await execute({ ...invocation(fake, { id: 'to-1', timeoutMs: 20000 }), resume: { message: 'continue' } });
  assert.ok(again.usage.modelRequests >= 1);
  assert.equal(again.usage.incomplete, undefined);
  assert.equal(again.usageTotal.modelRequests, 1 + again.usage.modelRequests);
});

test('task default timeout is 2 h; run/agent unchanged', () => {
  const { parseArgv } = require('../../bin/zcode.js');
  const exec = require('../../lib/commands/exec.js');
  assert.equal(exec.buildInvocation(parseArgv(['task', '--cwd', fake.work, 'go'])).timeoutMs, 7200000);
  assert.equal(exec.buildInvocation(parseArgv(['run', '--cwd', fake.work, 'go'])).timeoutMs, 600000);
});

// --- 4. hygiene ---------------------------------------------------------------------------------

test('ensureLocalExclude: appends .zcode/ and .playwright-mcp/ once; never touches .gitignore; worktrees work', () => {
  const repo = path.join(fake.base, 'repo');
  fs.mkdirSync(repo);
  const git = (...a) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' });
  git('init', '-q');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'x');
  git('add', '.');
  git('commit', '-qm', 'i');
  ensureLocalExclude(repo);
  ensureLocalExclude(repo);
  const file = path.join(repo, '.git', 'info', 'exclude');
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  assert.equal(lines.filter((l) => l === '.zcode/').length, 1);
  assert.equal(lines.filter((l) => l === '.playwright-mcp/').length, 1);
  assert.ok(!fs.existsSync(path.join(repo, '.gitignore')));
  fs.mkdirSync(path.join(repo, '.zcode'));
  fs.writeFileSync(path.join(repo, '.zcode', 'x'), '1');
  assert.equal(git('status', '--porcelain').trim(), '');
  const wt = path.join(fake.base, 'wt');
  git('worktree', 'add', '-q', wt);
  ensureLocalExclude(wt);
  const common = execFileSync('git', ['-C', wt, 'rev-parse', '--git-path', 'info/exclude'], { encoding: 'utf8' }).trim();
  assert.match(fs.readFileSync(path.resolve(wt, common), 'utf8'), /\.playwright-mcp\//);
  ensureLocalExclude(path.join(fake.base, 'not-a-repo-' + Date.now())); // silent
});

// --- 5. discovery ---------------------------------------------------------------------------------

test('<command> --help: only that command, each under 2000 bytes; bare --help keeps the full text', async () => {
  const full = await run(['--help']);
  assert.ok(Buffer.byteLength(full.stdout) > 6000);
  for (const cmd of ['task', 'run', 'agent', 'resume', 'status', 'wait', 'result', 'cancel', 'plan', 'doctor', 'login', 'skills']) {
    const r = await run([cmd, '--help']);
    assert.equal(r.code, 0, cmd);
    assert.ok(Buffer.byteLength(r.stdout) <= 2000, `${cmd}: ${Buffer.byteLength(r.stdout)} bytes`);
    assert.match(r.stdout, new RegExp(`zcode (\\[run\\] |${cmd})`), cmd);
    assert.ok(!/exit codes:/.test(r.stdout), `${cmd} is not the full text`);
  }
  assert.match((await run(['plan', '--help'])).stdout, /plan resume <name>/);
});

test('status: 15 most recent + a "more" line; --all lists everything; --json unchanged', async () => {
  for (let i = 0; i < 18; i++) {
    store.createSession(`s${String(i).padStart(2, '0')}`, { kind: 'task', cwd: fake.work });
  }
  const r = await run(['status']);
  const rows = r.stdout.trim().split('\n');
  assert.equal(rows.length, 16);
  assert.equal(rows[15], '… 3 more (zcode status --all)');
  const all = await run(['status', '--all']);
  assert.equal(all.stdout.trim().split('\n').length, 18);
  const json = JSON.parse((await run(['status', '--json'])).stdout);
  assert.equal(json.sessions.length, 18);
});

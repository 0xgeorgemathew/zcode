'use strict';
// zcode plan: validation, ordered/concurrent runs, skip-downstream, preflight,
// one-line wait output, resume, the detached supervisor and status recovery.
// The CLI runs as real child processes against the scripted fake engine.
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { cli } = require('../helpers/env.js');
const { setupFake, handback } = require('../helpers/fake.js');
const store = require('../../lib/store.js');
const plans = require('../../lib/plan.js');

let fake;
beforeEach(() => {
  fake = setupFake();
});
afterEach(() => fake.cleanup());

const run = (args, opts = {}) => cli(args, { cwd: fake.work, timeoutMs: 90000, ...opts });
const lines = (stdout) => stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const done = () => handback({ status: 'done', summary: 'ok' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function writePlan(plan, name = 'plan.json') {
  const file = path.join(fake.work, name);
  fs.writeFileSync(file, JSON.stringify(plan));
  return file;
}

// A session that completes under the fake engine: no edits, one passing check.
const sess = (id, extra = {}) => ({ id, objective: `do ${id}`, owns: [`${id}/**`], checks: ['true'], ...extra });
const problemsOf = (plan, opts = { name: 'p' }) => plans.checkPlan(plans.resolvePlan(writePlan(plan), fake.work), opts);

async function until(pred, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return;
    await sleep(100);
  }
  assert.fail('condition not reached in time');
}

// --- check ----------------------------------------------------------------------

test('plan check: cycles, unknown after, duplicate ids, concurrent owns overlap, bad effort, bad contract', () => {
  assert.deepEqual(problemsOf({ sessions: [sess('a'), sess('b', { after: ['a'] })] }), []);

  const cycle = problemsOf({ sessions: [sess('a', { after: ['b'] }), sess('b', { after: ['a'] })] });
  assert.ok(cycle.some((p) => /dependency cycle: (a -> b -> a|b -> a -> b)/.test(p)), cycle.join('\n'));

  assert.ok(problemsOf({ sessions: [sess('a', { after: ['zz'] })] }).some((p) => /after "zz" is not a session/.test(p)));
  assert.ok(problemsOf({ sessions: [sess('a'), sess('a')] }).some((p) => /duplicate session id "a"/.test(p)));
  assert.ok(problemsOf({ sessions: [{ objective: 'x' }] }).some((p) => /"id" must be/.test(p)));

  // Concurrent sessions with overlapping (or default whole-workspace) owns are refused...
  const overlap = problemsOf({ sessions: [sess('a', { owns: ['src/**'] }), sess('b', { owns: ['src/x/**'] }), sess('c', { owns: [] })] });
  assert.ok(overlap.some((p) => /"a" and "b" can run concurrently but their owns overlap/.test(p)), overlap.join('\n'));
  assert.ok(overlap.some((p) => /"c" can run concurrently|"a" and "c"/.test(p)));
  // ...unless one transitively depends on the other.
  assert.deepEqual(
    problemsOf({ sessions: [sess('a', { owns: [] }), sess('b', { owns: [], after: ['a'] }), sess('c', { owns: [], after: ['b'] })] }),
    []
  );
  assert.ok(problemsOf({ sessions: [sess('a', { owns: [] }), sess('b', { owns: [], after: ['a'] }), sess('c', { owns: [], after: ['a'] })] })
    .some((p) => /"b" and "c" can run concurrently/.test(p)));

  const effort = problemsOf({ effort: 'medium', sessions: [sess('a'), sess('b', { effort: 'xhigh' })] });
  assert.equal(effort.filter((p) => /not supported by GLM-5\.3-Flash \(supported: low, high, max\)/.test(p)).length, 2, effort.join('\n'));
  assert.ok(problemsOf({ sessions: [sess('a', { model: 'gpt-4' })] }).some((p) => /unknown model/.test(p)));
  assert.ok(problemsOf({ sessions: [sess('a', { bogus: 1 })] }).some((p) => /session "a": unknown task contract key/.test(p)));
  assert.ok(problemsOf({ sessions: [sess('a', { decisions: ['@missing.md'] })] }).some((p) => /could not be read/.test(p)));
  assert.ok(problemsOf({ nope: 1, sessions: [sess('a')] }).some((p) => /unknown plan key/.test(p)));
});

test('plan check: exit 2 with one line per problem; ok line otherwise; existing session ids are refused', async () => {
  const file = writePlan({ sessions: [sess('a', { after: ['b'] }), sess('b', { after: ['a'] }), sess('c', { after: ['nope'] })] });
  const bad = await run(['plan', 'check', file]);
  assert.equal(bad.code, 2);
  const errs = bad.stderr.trim().split('\n');
  assert.equal(errs.length, 2);
  assert.ok(errs.every((l) => l.startsWith('zcode: ')));

  const good = writePlan({ sessions: [sess('a'), sess('b', { after: ['a'] })] }, 'good.json');
  const ok = await run(['plan', 'check', good]);
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal(ok.stdout.trim(), 'plan good: 2 sessions, ok');
  assert.deepEqual(lines((await run(['plan', 'check', good, '--json'])).stdout), [{ type: 'plan-check', ok: true, name: 'good', sessions: 2 }]);

  store.createSession('a', { kind: 'task' });
  const taken = await run(['plan', 'check', good]);
  assert.equal(taken.code, 2);
  assert.match(taken.stderr, /session "a" already exists/);
  assert.match(taken.stderr, /zcode plan resume good/);
});

test('plan top-level decisions, context and files are prepended; @entries resolve next to the plan file', () => {
  fs.writeFileSync(path.join(fake.work, 'dec.md'), 'Monthly pricing only\n');
  const r = plans.resolvePlan(writePlan({
    decisions: ['@dec.md', 'D0'], context: ['C0'], files: ['f0'], model: 'glm-5.3', effort: 'low',
    sessions: [sess('a', { decisions: ['D1'], files: ['f1'], effort: 'high' })],
  }), fake.work);
  assert.deepEqual(plans.checkPlan(r, { name: 'p' }), []);
  const { buildContract } = require('../../lib/taskspec.js');
  const c = buildContract({ base: plans.sessionBase(r, r.plan.sessions[0]), baseDir: r.dir, cwd: r.cwd });
  assert.deepEqual(c.decisions, ['Monthly pricing only', 'D0', 'D1']);
  assert.deepEqual(c.context, ['C0']);
  assert.deepEqual(c.files, ['f0', 'f1']);
  assert.equal(c.model, 'glm-5.3');
  assert.equal(c.effort, 'high');
});

// --- run ------------------------------------------------------------------------

test('plan run: B waits for A; C and D run concurrently; one JSON line, exit 0', async () => {
  fake.setScript({ turns: [{ response: done(), delayMs: 800 }] });
  const file = writePlan({ sessions: [sess('A'), sess('B', { after: ['A'] }), sess('C'), sess('D')] }, 'order.json');
  const r = await run(['plan', 'run', file, '--json']);
  assert.equal(r.code, 0, r.stderr + r.stdout);
  const [report] = lines(r.stdout);
  assert.equal(lines(r.stdout).length, 1);
  assert.equal(report.type, 'plan');
  assert.equal(report.name, 'order');
  assert.equal(report.status, 'completed');
  assert.deepEqual(report.sessions, ['A', 'B', 'C', 'D'].map((id) => ({ id, status: 'completed' })));
  assert.deepEqual(report.briefs, []);

  const rec = (id) => store.readSession(id);
  assert.ok(rec('B').createdAt >= rec('A').updatedAt, 'B started only after A finished');
  assert.ok(rec('C').createdAt < rec('D').updatedAt && rec('D').createdAt < rec('C').updatedAt, 'C and D overlapped');
  assert.ok(rec('C').createdAt < rec('A').updatedAt, 'C did not wait for A');
  assert.equal(store.readPlanState('order').supervisor, null);

  const again = await run(['plan', 'run', file]);
  assert.equal(again.code, 7);
  assert.match(again.stderr, /plan "order" already exists/);
  const human = await run(['plan', 'status', 'order']);
  assert.equal(human.code, 0);
  assert.deepEqual(human.stdout.trim().split('\n'), ['A completed', 'B completed', 'C completed', 'D completed']);
});

test('plan run: a failing session skips its downstream; independent sessions continue', async () => {
  fake.setScript({ turns: [{ response: done() }] });
  const file = writePlan({
    sessions: [
      sess('A', { checks: ['false'], limits: { maxRepairs: 0 } }),
      sess('B', { after: ['A'] }),
      sess('C', { after: ['B'] }),
      sess('D'),
    ],
  }, 'skip.json');
  const r = await run(['plan', 'run', file, '--json']);
  assert.equal(r.code, 8, r.stderr);
  const [report] = lines(r.stdout);
  assert.equal(report.status, 'failed');
  assert.deepEqual(Object.fromEntries(report.sessions.map((s) => [s.id, s.status])), { A: 'failed', B: 'skipped', C: 'skipped', D: 'completed' });
  assert.deepEqual(report.briefs.map((b) => b.id), ['A']);
  assert.equal(report.briefs[0].schema, 'zcode.brief/1');
  assert.equal(store.readSession('B'), null);
  assert.equal(store.readSession('C'), null);
});

test('plan run: a blocked session exits 10 and its questions reach the human view', async () => {
  fake.setScript({ turns: [{ response: handback({ status: 'blocked', summary: 'need input', questions: [{ q: 'Which CTA?', options: ['A Start', 'B Buy'], recommend: 'A Start' }] }) }] });
  const file = writePlan({ sessions: [sess('A'), sess('B', { after: ['A'] })] }, 'blocked.json');
  const r = await run(['plan', 'run', file]);
  assert.equal(r.code, 10, r.stderr);
  assert.match(r.stdout, /^A blocked - need input\n {2}\? Which CTA\?\n {4}- A Start\n {4}- B Buy\n {4}recommend: A Start\nB skipped\n$/);

  const noMsg = await run(['plan', 'resume', 'blocked']);
  assert.equal(noMsg.code, 2);
  assert.match(noMsg.stderr, /answer the questions: zcode plan resume blocked "…"/);
});

// --- preflight --------------------------------------------------------------------

test('plan run --preflight: <id>.pre sessions, aggregated questions as briefs, exit 10, no plan state; re-run replaces', async () => {
  fake.setScript({ turns: [{ response: handback({ status: 'blocked', summary: 'open questions', questions: ['Annual plan?'] }) }] });
  const file = writePlan({ sessions: [sess('A'), sess('B', { after: ['A'] })] }, 'pre.json');
  const r = await run(['plan', 'run', file, '--preflight', '--json']);
  assert.equal(r.code, 10, r.stderr);
  const briefs = lines(r.stdout);
  assert.deepEqual(briefs.map((b) => b.id).sort(), ['A.pre', 'B.pre']);
  for (const b of briefs) {
    assert.equal(b.schema, 'zcode.brief/1');
    assert.deepEqual(b.questions, ['Annual plan?']);
    assert.equal(b.preflight, true);
  }
  assert.equal(store.readPlanState('pre'), null);
  assert.equal(store.readSession('A'), null);
  assert.equal(store.readSession('A.pre').preflight, true);
  const first = store.readSession('A.pre').createdAt;

  const again = await run(['plan', 'run', file, '--preflight', '--json']);
  assert.equal(again.code, 10);
  assert.notEqual(store.readSession('A.pre').createdAt, first);

  // No open questions: exit 0 with one line.
  fake.setScript({ turns: [{ response: handback({ status: 'done', summary: 'no open questions' }) }] });
  const none = await run(['plan', 'run', file, '--preflight', '--json']);
  assert.equal(none.code, 0, none.stdout + none.stderr);
  assert.deepEqual(lines(none.stdout), [{ type: 'preflight', name: 'pre', status: 'completed', sessions: 2 }]);

  // The plan itself is still runnable afterwards (ids and name are free).
  fake.setScript({ turns: [{ response: done() }] });
  const real = await run(['plan', 'run', file, '--json']);
  assert.equal(real.code, 0, real.stderr + real.stdout);
  assert.equal(lines(real.stdout)[0].status, 'completed');
});

// --- wait, detached supervisor, recovery ------------------------------------------

test('detached supervisor: one-line start, plan wait timeout (one line, 124), then the final summary with briefs', async () => {
  fake.setScript({ turns: [{ hang: true, response: 'x' }] });
  const file = writePlan({ sessions: [sess('A'), sess('B', { after: ['A'] })] }, 'det.json');
  const d = await run(['plan', 'run', file, '--detach']);
  assert.equal(d.code, 0, d.stderr);
  assert.deepEqual(lines(d.stdout), [{ type: 'plan', name: 'det', status: 'running' }]);
  assert.equal(supervisorPid('det') > 0, true);

  const w = await run(['plan', 'wait', 'det', '--json', '--timeout-ms', '1500']);
  assert.equal(w.code, 124);
  assert.equal(w.stdout.trim().split('\n').length, 1);
  const t = lines(w.stdout)[0];
  assert.equal(t.status, 'running');
  assert.equal(t.briefs, undefined);
  assert.equal(t.sessions[0].id, 'A');
  assert.match(t.sessions[0].status, /queued|running/);
  assert.deepEqual(t.sessions[1], { id: 'B', status: 'pending' });
  const human = await run(['plan', 'wait', 'det', '--timeout-ms', '800']);
  assert.equal(human.code, 124);
  assert.match(human.stdout, /^A (queued|running)\nB pending\n$/);

  await until(() => store.readSession('A').phase === 'executing');
  await run(['cancel', 'A']);
  const f = await run(['plan', 'wait', 'det', '--json', '--timeout-ms', '30000']);
  assert.equal(f.code, 8, f.stderr);
  const final = lines(f.stdout);
  assert.equal(final.length, 1);
  assert.equal(final[0].status, 'failed');
  assert.deepEqual(final[0].sessions, [{ id: 'A', status: 'cancelled' }, { id: 'B', status: 'skipped' }]);
  assert.deepEqual(final[0].briefs.map((b) => b.id), ['A']);
  await until(() => store.readPlanState('det').supervisor === null);
});

const supervisorPid = (name) => (store.readPlanState(name).supervisor || {}).pid;

test('status stays accurate when the supervisor dies; plan resume restarts supervision', async () => {
  fake.setScript({ turns: [{ hang: true, response: 'x' }] });
  const file = writePlan({ sessions: [sess('A'), sess('B', { after: ['A'] })] }, 'dead.json');
  assert.equal((await run(['plan', 'run', file, '--detach'])).code, 0);
  await until(() => store.readSession('A') && store.readSession('A').phase === 'executing');
  process.kill(supervisorPid('dead'), 'SIGKILL');
  await until(() => !store.pidAlive(supervisorPid('dead')));

  // A is still running without a supervisor.
  let s = lines((await run(['plan', 'status', 'dead', '--json'])).stdout)[0];
  assert.equal(s.status, 'running');
  assert.deepEqual(s.sessions, [{ id: 'A', status: 'running' }, { id: 'B', status: 'pending' }]);

  await run(['cancel', 'A']);
  s = lines((await run(['plan', 'status', 'dead', '--json'])).stdout)[0];
  assert.equal(s.status, 'failed');
  assert.deepEqual(s.sessions, [{ id: 'A', status: 'cancelled' }, { id: 'B', status: 'skipped' }]);
  assert.equal(s.briefs[0].id, 'A');

  // Never-started work with a dead supervisor: interrupted, resumable.
  const file2 = writePlan({ sessions: [sess('X')] }, 'orphan.json');
  store.createPlanState('orphan', { file: file2, cwd: fake.work, sessions: ['X'], supervisor: { pid: 999999 }, launchErrors: {} });
  const o = lines((await run(['plan', 'status', 'orphan', '--json'])).stdout)[0];
  assert.equal(o.status, 'interrupted');
  assert.deepEqual(o.sessions, [{ id: 'X', status: 'pending' }]);
  fake.setScript({ turns: [{ response: done() }] });
  const w = await run(['plan', 'wait', 'orphan', '--json', '--timeout-ms', '800']);
  assert.equal(w.code, 8); // wait does not hang on a dead supervisor
  const r = await run(['plan', 'resume', 'orphan', '--json']);
  assert.equal(r.code, 0, r.stderr + r.stdout);
  assert.deepEqual(lines(r.stdout)[0].sessions, [{ id: 'X', status: 'completed' }]);
});

// --- resume -----------------------------------------------------------------------

test('plan resume: failed sessions resume, their skipped downstream launches once they complete', async () => {
  fake.setScript({ turns: [{ response: done() }] });
  const file = writePlan({
    sessions: [
      sess('A', { checks: ['test -f ok.flag'], limits: { maxRepairs: 0 } }),
      sess('B', { after: ['A'] }),
      sess('C'),
    ],
  }, 'res.json');
  const first = await run(['plan', 'run', file, '--json']);
  assert.equal(first.code, 8);
  assert.deepEqual(lines(first.stdout)[0].sessions.map((s) => s.status), ['failed', 'skipped', 'completed']);

  const none = await run(['plan', 'resume', 'res', '--session', 'C']);
  assert.equal(none.code, 2);
  assert.match(none.stderr, /session "C" is completed/);

  fs.writeFileSync(path.join(fake.work, 'ok.flag'), '');
  const r = await run(['plan', 'resume', 'res', 'Continue: the flag exists now.', '--json']);
  assert.equal(r.code, 0, r.stderr + r.stdout);
  const report = lines(r.stdout)[0];
  assert.equal(report.status, 'completed');
  assert.deepEqual(report.sessions.map((s) => s.status), ['completed', 'completed', 'completed']);
  const msgs = fake.log().filter((e) => e.method === 'session/send').map((e) => e.params.content);
  assert.ok(msgs.some((m) => /the flag exists now/.test(m)));
  assert.ok(store.readSession('B').createdAt >= store.readSession('A').updatedAt);

  const nothing = await run(['plan', 'resume', 'res', '--json']);
  assert.equal(nothing.code, 0);
  assert.equal(lines(nothing.stdout)[0].status, 'completed');
});

'use strict';
// Quiet output: the compact brief vs the full record, `zcode result`,
// one-line wait timeouts, `wait --any`, and one-line usage errors. The CLI
// runs as a real child process against the scripted fake engine.
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { cli } = require('../helpers/env.js');
const { setupFake, handback, invocation } = require('../helpers/fake.js');
const { buildBrief } = require('../../lib/brief.js');
const { execute } = require('../../lib/executor.js');
const store = require('../../lib/store.js');

let fake;
beforeEach(() => {
  fake = setupFake();
});
afterEach(() => fake.cleanup());

const lastJson = (stdout) => JSON.parse(stdout.trim().split('\n').pop());
const run = (args, opts = {}) => cli(args, { cwd: fake.work, timeoutMs: 60000, ...opts });

function scriptCheck(name, body) {
  fs.writeFileSync(path.join(fake.work, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}

test('brief: passing check reduced to command+ok, failing check carries exit code and a bounded tail', async () => {
  fake.setScript({ turns: [{ write: { path: 'a.txt', content: 'x' }, response: handback({ status: 'done', summary: 's' }) }] });
  const r = await execute(invocation(fake, {
    maxRepairs: 0,
    contract: { checks: ['echo fine', 'yes boom | head -c 5000 >&2; exit 4'] },
  }));
  const b = buildBrief(r);
  assert.equal(b.type, 'result');
  assert.equal(b.schema, 'zcode.brief/1');
  assert.equal(b.status, 'failed');
  assert.deepEqual(b.files, ['a.txt']);
  assert.deepEqual(b.checks[0], { command: 'echo fine', ok: true });
  assert.equal(b.checks[1].ok, false);
  assert.equal(b.checks[1].exitCode, 4);
  assert.equal(b.checks[1].tail.length, 1500);
  assert.equal(b.error.kind, 'checks_failed');
  assert.equal(b.result, r.files.result);
  // Empty keys are omitted; heavyweight fields never appear.
  for (const k of ['questions', 'unresolved', 'scopeViolations', 'label', 'touched', 'response', 'changes', 'usage', 'handback']) {
    assert.ok(!(k in b), `${k} omitted`);
  }
});

test('brief: summary is ellipsised at 600 chars; error message at 500; run keeps the response', async () => {
  const long = 'x'.repeat(2000);
  const b = buildBrief({
    status: 'failed', ok: false, id: 'i', kind: 'task', summary: long,
    error: { kind: 'engine', message: long }, issues: ['y'.repeat(50)],
  });
  assert.equal(b.summary.length, 600);
  assert.ok(b.summary.endsWith('…'));
  assert.equal(b.error.message.length, 500);
  assert.deepEqual(b.issues, ['y'.repeat(50)], 'issues that are not the error message stay');

  fake.setScript({ turns: [{ response: 'the answer' }] });
  const r = await execute(invocation(fake, { kind: 'run' }));
  const rb = buildBrief(r);
  assert.equal(rb.response, 'the answer');
  assert.equal(rb.ok, true);
});

test('task --json prints the brief as the last line; --full prints the full record; result.json stays full', async () => {
  fake.setScript({ turns: [{ write: { path: 'a.txt', content: 'x' }, response: handback({ status: 'done', summary: 'did it' }) }] });
  scriptCheck('ok.sh', 'echo ok');
  const brief = await run(['task', '--json', '--id', 'b-1', '--check', './ok.sh', '--owns', 'a.txt', 'Do it']);
  assert.equal(brief.code, 0, brief.stderr);
  const b = lastJson(brief.stdout);
  assert.equal(b.schema, 'zcode.brief/1');
  assert.equal(b.status, 'completed');
  assert.deepEqual(b.files, ['a.txt']);
  assert.ok(!('changes' in b) && !('usage' in b));

  fake.resetEngineState();
  const full = await run(['task', '--json', '--full', '--id', 'b-2', '--check', './ok.sh', '--owns', 'a.txt', 'Do it']);
  const f = lastJson(full.stdout);
  assert.equal(f.schema, 'zcode.result/1');
  assert.ok(f.changes && f.usage && f.handback);

  const onDisk = JSON.parse(fs.readFileSync(path.join(store.sessionDir('b-1'), 'result.json'), 'utf8'));
  assert.equal(onDisk.schema, 'zcode.result/1');
  assert.equal(b.result, path.join(store.sessionDir('b-1'), 'result.json'));
});

test('zcode result <id>: brief with --json, human view without, full with --full; refuses a running session', async () => {
  fake.setScript({ turns: [{ response: handback({ status: 'done', summary: 'did it' }) }] });
  scriptCheck('ok.sh', 'echo ok');
  const started = await run(['task', '--json', '--quiet', '--id', 'r-1', '--check', './ok.sh', 'Do it']);
  assert.equal(started.code, 0, started.stderr);

  const json = await run(['result', 'r-1', '--json']);
  assert.equal(json.code, 0);
  assert.equal(JSON.parse(json.stdout).schema, 'zcode.brief/1');

  const human = await run(['result', 'r-1']);
  assert.match(human.stdout, /completed/);
  assert.match(human.stdout, /did it/);

  const full = await run(['result', 'r-1', '--full']);
  assert.equal(JSON.parse(full.stdout).schema, 'zcode.result/1');

  fake.setScript({ turns: [{ hang: true, response: 'x' }] });
  fake.resetEngineState();
  const d = await run(['task', '--detach', '--id', 'r-2', 'Hang']);
  assert.equal(d.code, 0, d.stderr);
  const busy = await run(['result', 'r-2']);
  assert.equal(busy.code, 7);
  assert.match(busy.stderr, /still (queued|running)/);
  assert.equal(busy.stderr.trim().split('\n').length, 1);
  await run(['cancel', 'r-2']);
});

test('wait timeout: exactly one line per pending session (json and human), exit 124', async () => {
  fake.setScript({ turns: [{ hang: true, response: 'x' }] });
  for (const id of ['w-1', 'w-2']) {
    const d = await run(['task', '--detach', '--id', id, '--owns', `${id}/**`, 'Hang']);
    assert.equal(d.code, 0, d.stderr);
  }
  const j = await run(['wait', 'w-1', 'w-2', '--json', '--timeout-ms', '700']);
  assert.equal(j.code, 124);
  assert.equal(j.stderr, '');
  const lines = j.stdout.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 2);
  for (const l of lines) {
    assert.deepEqual(Object.keys(l).sort(), ['elapsedMs', 'id', 'phase', 'state', 'type']);
    assert.equal(l.type, 'pending');
    assert.equal(typeof l.elapsedMs, 'number');
  }
  assert.deepEqual(lines.map((l) => l.id), ['w-1', 'w-2']);

  const h = await run(['wait', 'w-1', '--timeout-ms', '700']);
  assert.equal(h.code, 124);
  assert.match(h.stdout, /^w-1 (queued|running) \S+ \d+[smh]\d*m?\n$/);
  for (const id of ['w-1', 'w-2']) await run(['cancel', id]);
});

test('wait --any returns the first finished session; the other keeps running', async () => {
  fake.setScript({ turns: [{ hang: true, response: 'x' }] });
  const slow = await run(['task', '--detach', '--id', 'any-slow', '--owns', 'slow/**', 'Hang']);
  assert.equal(slow.code, 0, slow.stderr);
  // The worker starts asynchronously and the fake engine reads its script at
  // start: wait until the slow turn is under way before swapping the script.
  for (let i = 0; i < 100 && store.readSession('any-slow').phase !== 'executing'; i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(store.readSession('any-slow').phase, 'executing');
  // The fake engine script is read at engine start: the second session gets a quick turn.
  fake.setScript({ turns: [{ response: handback({ status: 'done', summary: 'quick' }) }] });
  fake.resetEngineState();
  scriptCheck('ok.sh', 'echo ok');
  const fast = await run(['task', '--detach', '--id', 'any-fast', '--owns', 'fast/**', '--check', './ok.sh', 'Quick']);
  assert.equal(fast.code, 0, fast.stderr);

  const w = await run(['wait', 'any-slow', 'any-fast', '--any', '--json', '--timeout-ms', '30000']);
  assert.equal(w.code, 0, w.stderr);
  const out = w.stdout.trim().split('\n');
  assert.equal(out.length, 1);
  const b = JSON.parse(out[0]);
  assert.equal(b.id, 'any-fast');
  assert.equal(b.schema, 'zcode.brief/1');
  assert.equal(store.viewSession(store.readSession('any-slow')).live, true);
  await run(['cancel', 'any-slow']);
});

test('usage errors are one line, never the help text; unknown flags get a suggestion; --quiet is silent on stderr', async () => {
  const unknown = await run(['task', '--fle', 'x', 'Do it']);
  assert.equal(unknown.code, 2);
  assert.equal(unknown.stderr, 'zcode: unknown flag --fle (did you mean --file?)\n');

  const nohint = await run(['task', '--zzzzzzzz', 'Do it']);
  assert.equal(nohint.code, 2);
  assert.equal(nohint.stderr.trim().split('\n').length, 1);
  assert.ok(!/usage:/.test(nohint.stderr));

  const missing = await run(['task', '--owns']);
  assert.equal(missing.code, 2);
  assert.equal(missing.stderr.trim().split('\n').length, 1);
  assert.ok(!/usage:/.test(missing.stderr));

  const any = await run(['task', '--any', 'x']);
  assert.equal(any.code, 2);
  assert.match(any.stderr, /--any is only valid with "zcode wait"/);

  fake.setScript({ turns: [{ response: handback({ status: 'done', summary: 's' }) }] });
  scriptCheck('ok.sh', 'echo ok');
  const quiet = await run(['task', '--quiet', '--check', './ok.sh', 'Do it']);
  assert.equal(quiet.code, 0);
  assert.equal(quiet.stderr, '');
});

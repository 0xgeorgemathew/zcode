'use strict';
// Executor lifecycle against the scripted fake engine: handoff → turns →
// zcode-run checks → bounded repairs → diff/scope → status → handback, plus
// cancellation, timeout, blocked, resume, conflicts and isolation.
// No CLI process, no model, no real ~/.zcode.
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setupFake, handback, invocation, TEST_KEY } = require('../helpers/fake.js');
const { execute, exitCodeFor, ExecError } = require('../../lib/executor.js');
const store = require('../../lib/store.js');
const { acquireLease } = require('../../lib/workspace.js');

let fake;
beforeEach(() => {
  fake = setupFake();
});
afterEach(() => fake.cleanup());

const sends = () => fake.log().filter((e) => e.method === 'session/send').map((e) => e.params.content);

test('task: work + passing check → completed, with changes, evidence and a finished record', async () => {
  fake.setScript({
    turns: [{
      write: { path: 'src/a.txt', content: 'hello' },
      tool: 'Write',
      response: handback({ status: 'done', summary: 'wrote a.txt', criteria: [{ criterion: 'a exists', met: true }] }),
    }],
  });
  const inv = invocation(fake, {
    id: 'page-1',
    contract: { checks: ['test -f src/a.txt'], owns: ['src/**'] },
  });
  const events = [];
  const r = await execute(inv, { onEvent: (e) => events.push(e) });

  assert.equal(r.status, 'completed');
  assert.equal(r.ok, true);
  assert.equal(exitCodeFor(r), 0);
  assert.equal(r.summary, 'wrote a.txt');
  assert.equal(r.response, 'Report text.');
  assert.equal(r.sessionId, 'sess_fake1');
  assert.equal(r.mode, 'yolo');
  assert.deepEqual(r.changes.files, [{ path: 'src/a.txt', change: 'added', owned: true }]);
  assert.deepEqual(r.scopeViolations, []);
  assert.equal(r.checksPassed, true);
  assert.equal(r.checks[0].exitCode, 0);
  assert.equal(r.turns, 1);
  assert.deepEqual(r.usage, { inputTokens: 100, outputTokens: 10, modelRequests: 1 });
  assert.deepEqual(r.usageTotal, { inputTokens: 100, outputTokens: 10, modelRequests: 1 });

  // The engine got the executor protocol with ownership + checks + handback spec.
  const [prompt] = sends();
  assert.match(prompt, /## Objective\ndo the thing/);
  assert.match(prompt, /You may create, modify or delete ONLY these paths[\s\S]*- src\/\*\*/);
  assert.match(prompt, /`test -f src\/a.txt`/);
  assert.match(prompt, /```zcode-handback/);

  // Lifecycle record + persisted handback.
  const rec = store.readSession('page-1');
  assert.equal(rec.state, 'finished');
  assert.equal(rec.status, 'completed');
  assert.equal(rec.engineSessionId, 'sess_fake1');
  assert.deepEqual(store.readResult('page-1').status, 'completed');
  const phases = events.filter((e) => e.type === 'phase').map((e) => e.phase);
  assert.deepEqual(phases, ['starting', 'executing', 'checking']);
  assert.ok(events.some((e) => e.type === 'check' && e.phase === 'finished' && e.ok));

  // Isolation: the session's own HOME, key swapped in, OAuth creds never copied.
  const home = path.join(store.sessionDir('page-1'), 'home');
  const pc = JSON.parse(fs.readFileSync(path.join(home, '.zcode', 'v2', 'provider_config.json'), 'utf8'));
  assert.equal(pc.config.providerConfigRules.providerRules.length, 1);
  assert.equal(pc.config.providerConfigRules.providerRules[0].config.access.apiKey, TEST_KEY);
  assert.ok(!fs.existsSync(path.join(home, '.zcode', 'v2', 'credentials.json')));
  assert.ok(fake.log().some((e) => e.home === home), 'engine ran with HOME = the session home');
  assert.ok(!fs.readFileSync(path.join(store.sessionDir('page-1'), 'result.json'), 'utf8').includes(TEST_KEY));
});

test('task: failing check → repair turn with the failure output → completed', async () => {
  fake.setScript({
    turns: [
      { response: handback({ status: 'done', summary: 'first try' }) },
      { write: { path: 'out.txt', content: 'x' }, response: handback({ status: 'done', summary: 'fixed' }) },
    ],
  });
  const r = await execute(invocation(fake, { contract: { checks: ['test -f out.txt && echo found'] } }));
  assert.equal(r.status, 'completed');
  assert.equal(r.repairs, 1);
  assert.equal(r.turns, 2);
  assert.equal(r.summary, 'fixed');
  const [, repair] = sends();
  assert.match(repair, /repair attempt 1 of 2/);
  assert.match(repair, /`test -f out.txt && echo found` \(exit 1\)/);
});

test('task: checks still failing after the repair budget → failed (exit 8), no extra turns', async () => {
  fake.setScript({ turns: [{ response: handback({ status: 'done', summary: 'claims done' }) }] });
  const r = await execute(invocation(fake, { maxRepairs: 1, contract: { checks: ['echo boom >&2; exit 3'] } }));
  assert.equal(r.status, 'failed');
  assert.equal(r.error.kind, 'checks_failed');
  assert.equal(exitCodeFor(r), 8);
  assert.equal(r.turns, 2, 'one execution turn + one repair turn');
  assert.equal(r.checks[0].exitCode, 3);
  assert.match(r.checks[0].output, /boom/);
  assert.equal(r.ok, false, 'a model claiming "done" is not completion');
});

test('task: no checks declared → unverified (exit 9), says why', async () => {
  fake.setScript({ turns: [{ response: handback({ status: 'done', summary: 's' }) }] });
  const r = await execute(invocation(fake));
  assert.equal(r.status, 'unverified');
  assert.equal(exitCodeFor(r), 9);
  assert.ok(r.notVerified.some((n) => /no acceptance checks/.test(n)));
});

test('task: blocked handback → blocked (exit 10) with questions; checks are not run', async () => {
  fake.setScript({ turns: [{ response: handback({ status: 'blocked', summary: 'need a decision', questions: ['Which palette?'] }) }] });
  const r = await execute(invocation(fake, { contract: { checks: ['exit 1'] } }));
  assert.equal(r.status, 'blocked');
  assert.equal(exitCodeFor(r), 10);
  assert.deepEqual(r.questions, ['Which palette?']);
  assert.deepEqual(r.checks, []);
});

test('task: missing handback → exactly one handback request, substantive report kept', async () => {
  fake.setScript({
    turns: [
      { response: 'I did the work but forgot the block.' },
      { response: handback({ status: 'done', summary: 'late handback' }) },
    ],
  });
  const r = await execute(invocation(fake, { contract: { checks: ['true'] } }));
  assert.equal(r.status, 'completed');
  assert.equal(r.turns, 2);
  assert.match(sends()[1], /did not end with a valid zcode-handback block/);
});

test('task: a change outside the owned scope → partial, listed as a violation', async () => {
  fake.setScript({ turns: [{ write: { path: 'README.md', content: 'x' }, response: handback({ status: 'done', summary: 's' }) }] });
  const r = await execute(invocation(fake, { contract: { checks: ['true'], owns: ['src/**'] } }));
  assert.equal(r.status, 'partial');
  assert.deepEqual(r.scopeViolations, ['README.md']);
  assert.equal(exitCodeFor(r), 8);
});

test('cancel: abort mid-turn sends session/stop and records cancelled (exit 130)', async () => {
  fake.setScript({ turns: [{ hang: true }] });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 400);
  const r = await execute(invocation(fake, { id: 'c1' }), { signal: controller.signal });
  assert.equal(r.status, 'cancelled');
  assert.equal(exitCodeFor(r), 130);
  assert.ok(fake.log().some((e) => e.method === 'session/stop'), 'engine was told to stop');
  assert.equal(store.readSession('c1').status, 'cancelled');
});

test('timeout: the whole invocation is bounded; engine stopped; exit 124', async () => {
  fake.setScript({ turns: [{ hang: true }] });
  const r = await execute(invocation(fake, { timeoutMs: 600 }));
  assert.equal(r.status, 'failed');
  assert.equal(r.error.kind, 'timeout');
  assert.equal(exitCodeFor(r), 124);
  assert.ok(fake.log().some((e) => e.method === 'session/stop'));
});

test('engine user-input request → blocked with the question, not a hang', async () => {
  fake.setScript({ turns: [{ userInput: 'Pick a framework' }] });
  const r = await execute(invocation(fake));
  assert.equal(r.status, 'blocked');
  assert.ok(r.questions.some((q) => /Pick a framework/.test(q)));
});

test('engine turn failure → failed (exit 5) with the scrubbed engine message', async () => {
  fake.setScript({ turns: [{ fail: `bad thing ${TEST_KEY}` }] });
  const r = await execute(invocation(fake, { kind: 'run' }));
  assert.equal(r.status, 'failed');
  assert.equal(exitCodeFor(r), 5);
  assert.ok(!r.error.message.includes(TEST_KEY), 'key scrubbed');
  assert.match(r.error.message, /\*\*\*/);
});

test('resume: same engine session, orchestrator message delivered, work continues', async () => {
  fake.setScript({
    turns: [
      { response: handback({ status: 'blocked', summary: 'q', questions: ['Which color?'] }) },
      { write: { path: 'c.txt', content: 'blue' }, response: handback({ status: 'done', summary: 'used blue' }) },
    ],
  });
  const inv = invocation(fake, { id: 'r1', contract: { checks: ['test -f c.txt'] } });
  const first = await execute(inv);
  assert.equal(first.status, 'blocked');

  const second = await execute({ ...inv, resume: { message: 'Use blue.' } });
  assert.equal(second.status, 'completed');
  assert.equal(second.resumed, true);
  assert.equal(second.sessionId, first.sessionId);
  const resumeCall = fake.log().find((e) => e.method === 'session/resume');
  assert.equal(resumeCall.params.sessionId, first.sessionId);
  const last = sends().pop();
  assert.match(last, /Message from the orchestrator:\n\nUse blue\./);
  assert.match(last, /already applied to the workspace/);
  assert.equal(store.readSession('r1').turns, 2);
});

test('run: plain one-shot answer → completed with the response text', async () => {
  fake.setScript({ turns: [{ response: '391' }] });
  const r = await execute(invocation(fake, { kind: 'run', prompt: 'What is 17*23?' }));
  assert.equal(r.status, 'completed');
  assert.equal(r.response, '391');
  assert.equal(sends()[0], 'What is 17*23?');
});

test('agent: verified against session/subagents; none dispatched → exit 6', async () => {
  fake.setScript({ turns: [{ tool: 'Agent', response: 'done' }], subagents: [{ agentId: 'agent_1', status: 'success', title: 't' }] });
  const ok = await execute(invocation(fake, { kind: 'agent', prompt: 'make a file' }));
  assert.equal(ok.status, 'completed');
  assert.equal(ok.subagents.length, 1);

  fake.resetEngineState();
  fake.setScript({ turns: [{ response: 'did it myself' }], subagents: [] });
  const none = await execute(invocation(fake, { kind: 'agent', prompt: 'make a file' }));
  assert.equal(none.status, 'failed');
  assert.equal(none.error.kind, 'no_subagent');
  assert.equal(exitCodeFor(none), 6);
});

test('workspace conflict: overlapping live session → refused (exit 7) and the id stays free', async () => {
  const other = acquireLease({ id: 'other', root: fake.work, owns: ['src/**'] });
  assert.ok(other.ok);
  try {
    await assert.rejects(
      execute(invocation(fake, { id: 'clash', contract: { owns: ['src/pages/**'] } })),
      (err) => err instanceof ExecError && err.exitCode === 7 && /other/.test(err.message)
    );
    assert.equal(store.readSession('clash'), null, 'refused start leaves no record');
    // Disjoint ownership runs fine alongside.
    fake.setScript({ turns: [{ response: handback({ status: 'done', summary: 's' }) }] });
    const r = await execute(invocation(fake, { contract: { owns: ['docs/**'] } }));
    assert.equal(r.status, 'unverified');
  } finally {
    other.release();
  }
});

test('duplicate --id is never re-run', async () => {
  fake.setScript({ turns: [{ response: 'ok' }] });
  await execute(invocation(fake, { id: 'dup', kind: 'run' }));
  await assert.rejects(execute(invocation(fake, { id: 'dup', kind: 'run' })), store.SessionExistsError);
  assert.equal(sends().length, 1);
});

// --- regressions from the 0.4 review ------------------------------------------

test('a sibling session that finished during our run owns its changes (not our scope violation)', async () => {
  store.createSession('sib', { kind: 'task', workspaceRoot: fake.work, ownsRoot: ['other/**'], state: 'running' });
  fake.setScript({ turns: [{ write: { path: 'other/x.txt', content: 's' }, response: handback({ status: 'done', summary: 's' }) }] });
  const r = await execute(invocation(fake, { contract: { checks: ['true'], owns: ['src/**'] } }), {
    onEvent: (e) => {
      if (e.type === 'phase' && e.phase === 'executing') store.updateSession('sib', { state: 'finished', status: 'completed' });
    },
  });
  assert.equal(r.status, 'completed');
  assert.deepEqual(r.scopeViolations, []);
  assert.equal(r.changes.files[0].concurrentSession, 'sib');
});

test('artifacts written by zcode\'s own checks are not scope violations', async () => {
  fake.setScript({ turns: [{ write: { path: 'src/a.txt', content: 'a' }, response: handback({ status: 'done', summary: 's' }) }] });
  const r = await execute(invocation(fake, { contract: { checks: ['mkdir -p coverage && echo x > coverage/out.txt'], owns: ['src/**'] } }));
  assert.equal(r.status, 'completed');
  assert.ok(r.changes.files.some((f) => f.path === 'coverage/out.txt' && f.fromChecks));
});

test('the run deadline expiring during a check is a timeout (124), not checks_failed', async () => {
  fake.setScript({ turns: [{ response: handback({ status: 'done', summary: 's' }) }] });
  const r = await execute(invocation(fake, { timeoutMs: 1500, contract: { checks: ['sleep 10'] } }));
  assert.equal(r.error.kind, 'timeout');
  assert.equal(exitCodeFor(r), 124);
});

test('a session already driven by a live process cannot be resumed concurrently (exit 7)', async () => {
  fake.setScript({ turns: [{ response: 'ok' }] });
  const inv = invocation(fake, { id: 'busy1', kind: 'run' });
  await execute(inv);
  const hold = store.claimSession('busy1');
  assert.ok(hold, 'test holds the owner lock');
  try {
    await assert.rejects(execute({ ...inv, resume: { message: 'again' } }), (e) => e.exitCode === 7 && e.kind === 'busy');
  } finally {
    hold();
  }
  assert.equal(sends().length, 1, 'nothing was sent twice');
});

test('ZAI_CODE_MAX_ACTIVE slots are claimed atomically; a full machine queues', async () => {
  process.env.ZAI_CODE_MAX_ACTIVE = '1';
  const slot = store.claimSlot(1);
  assert.ok(slot);
  try {
    assert.equal(store.claimSlot(1), null, 'second claim of the only slot fails');
    const events = [];
    const r = await execute(invocation(fake, { kind: 'run', timeoutMs: 1200 }), { onEvent: (e) => events.push(e) });
    assert.ok(events.some((e) => e.type === 'phase' && e.phase === 'queued'));
    assert.equal(r.error.kind, 'timeout');
    assert.equal(sends().length, 0, 'never reached the engine');
  } finally {
    slot();
    delete process.env.ZAI_CODE_MAX_ACTIVE;
  }
});

test('conflict and busy results map to exit 7 (wait on a detached conflict)', () => {
  assert.equal(exitCodeFor({ status: 'failed', error: { kind: 'conflict' } }), 7);
  assert.equal(exitCodeFor({ status: 'failed', error: { kind: 'busy' } }), 7);
});

test('cancel kills the engine\'s whole process tree (no late writes by tool subprocesses)', async () => {
  const marker = path.join(fake.work, 'late-write.txt');
  fake.setScript({ turns: [{ hang: true, grandchild: marker }] });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 300);
  const r = await execute(invocation(fake), { signal: controller.signal });
  assert.equal(r.status, 'cancelled');
  await new Promise((res) => setTimeout(res, 1500));
  assert.ok(!fs.existsSync(marker), 'tool subprocess died with the engine group');
});

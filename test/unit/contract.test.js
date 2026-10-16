'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeContract,
  ContractError,
  buildTaskPrompt,
  parseHandback,
  deriveStatus,
  buildRepairPrompt,
} = require('../../lib/contract.js');

test('normalizeContract: objective is the only requirement; flags extend the base', () => {
  const c = normalizeContract({ objective: 'Build page 1', acceptance: 'renders', design: ['dark hero'] }, {
    checks: ['npm test'],
    owns: ['src/p1/**'],
  });
  assert.equal(c.objective, 'Build page 1');
  assert.deepEqual(c.acceptance, ['renders']);
  assert.deepEqual(c.design, ['dark hero']);
  assert.deepEqual(c.checks, ['npm test']);
  assert.deepEqual(c.owns, ['src/p1/**']);
  assert.deepEqual(normalizeContract({}, { objective: 'small fix' }).checks, []);
});

test('normalizeContract: rejects typos, bad limits and a missing objective', () => {
  assert.throws(() => normalizeContract({ objective: 'x', acceptance_criteria: [] }), (e) => e instanceof ContractError && /acceptance_criteria/.test(e.message));
  assert.throws(() => normalizeContract({ objective: 'x', limits: { retries: 2 } }), ContractError);
  assert.throws(() => normalizeContract({ objective: 'x', limits: { maxRepairs: -1 } }), ContractError);
  assert.throws(() => normalizeContract({}), /needs an objective/);
  assert.throws(() => normalizeContract([]), ContractError);
});

test('buildTaskPrompt: only populated sections, design is binding, ownership + checks spelled out', () => {
  const c = normalizeContract({ objective: 'O', design: ['Use the supplied tokens'] }, { checks: ['npm run build'], owns: ['src/a/**'] });
  const p = buildTaskPrompt(c);
  assert.match(p, /implement exactly\)\n- Use the supplied tokens/);
  assert.match(p, /ONLY these paths[\s\S]*- src\/a\/\*\*/);
  assert.match(p, /`npm run build`/);
  assert.doesNotMatch(p, /## Scope/);
  assert.doesNotMatch(p, /## References/);
  assert.match(p, /A subagent reporting success is a claim/);
});

test('parseHandback: last block wins, report excludes it, aliases normalize', () => {
  const text = 'old\n```zcode-handback\n{"status":"partial"}\n```\nmore\n```zcode-handback\n{"status":"completed","summary":"s","questions":"q"}\n```';
  const { handback, report, error } = parseHandback(text);
  assert.equal(error, null);
  assert.equal(handback.status, 'done');
  assert.deepEqual(handback.questions, ['q']);
  assert.ok(report.startsWith('old'));
  assert.doesNotMatch(report, /"completed"/);
});

test('parseHandback: missing / invalid / statusless are reported, never thrown', () => {
  assert.equal(parseHandback('no block').error, 'missing');
  assert.match(parseHandback('```zcode-handback\n{nope\n```').error, /invalid JSON/);
  const r = parseHandback('```zcode-handback\n{"summary":"x"}\n```');
  assert.equal(r.handback.status, null);
  assert.match(r.error, /status/);
});

test('deriveStatus: evidence beats claims', () => {
  const done = { status: 'done', criteria: [], questions: [], unresolved: [] };
  const pass = [{ command: 'c', ok: true }];
  const failc = [{ command: 'c', ok: false }];
  assert.equal(deriveStatus({ kind: 'task', handback: done, checks: pass }).status, 'completed');
  assert.equal(deriveStatus({ kind: 'task', handback: done, checks: failc }).status, 'failed');
  assert.equal(deriveStatus({ kind: 'task', handback: done, checks: [] }).status, 'unverified');
  assert.equal(deriveStatus({ kind: 'task', handback: { ...done, status: 'partial' }, checks: pass }).status, 'partial');
  assert.equal(deriveStatus({ kind: 'task', handback: { ...done, criteria: [{ criterion: 'x', met: false }] }, checks: pass }).status, 'partial');
  assert.equal(deriveStatus({ kind: 'task', handback: done, checks: pass, scopeViolations: ['a'] }).status, 'partial');
  assert.equal(deriveStatus({ kind: 'task', handback: { ...done, status: 'blocked' }, checks: failc }).status, 'blocked');
  assert.equal(deriveStatus({ kind: 'task', handback: null, checks: pass }).status, 'unverified');
  assert.equal(deriveStatus({ kind: 'task', handback: { ...done, status: null }, checks: pass }).status, 'unverified', 'unknown status is not done');
  assert.equal(deriveStatus({ kind: 'task', handback: null, checks: [] }).status, 'unverified');
  assert.equal(deriveStatus({ kind: 'task', cancelled: true, error: new Error('x') }).status, 'cancelled');
  assert.equal(deriveStatus({ kind: 'task', userInput: 'q?' }).status, 'blocked');
  assert.equal(deriveStatus({ kind: 'run', error: new Error('boom') }).status, 'failed');
  assert.equal(deriveStatus({ kind: 'run' }).status, 'completed');
});

test('buildRepairPrompt carries the bounded failure output', () => {
  const p = buildRepairPrompt([{ command: 'npm test', exitCode: 1, timedOut: false, output: 'x'.repeat(5000) + 'TAIL' }], { attempt: 1, maxRepairs: 2 });
  assert.match(p, /repair attempt 1 of 2/);
  assert.match(p, /TAIL/);
  assert.ok(p.length < 4000);
});

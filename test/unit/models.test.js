'use strict';
// Effort validation before any engine spawn: levels come from the engine's
// builtin provider config (fallback table when unreadable), unsupported
// model+effort pairs exit 2 with one line, and doctor lists the levels.
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { cli } = require('../helpers/env.js');
const { setupFake, handback } = require('../helpers/fake.js');
const { supportedEfforts, modelLevels, effortProblem } = require('../../lib/models.js');

let fake;
beforeEach(() => {
  fake = setupFake({ turns: [{ response: handback({ status: 'done', summary: 's' }) }] });
});
afterEach(() => fake.cleanup());

const MATCH = '.*glm-5\\.3(?:-flash)?(?:[.\\-:/\\[].*)?';
function builtin(name, rules) {
  const file = path.join(fake.base, name);
  fs.writeFileSync(file, JSON.stringify({ config: { modelConfigRules: { modelRules: rules } } }));
  return file;
}

test('levels are read from the builtin provider config; the last matching rule with values wins', () => {
  const file = builtin('b1.json', [
    { modelMatch: '.*glm-5(?:[.\\-:/\\[].*)?', config: { optionSpecs: { reasoningLevel: { values: ['disabled', 'enabled'] } } } },
    { modelMatch: MATCH, config: { optionSpecs: { reasoningLevel: { values: ['low', 'medium', 'max'] } } } },
    { modelMatch: '.*other.*', config: { optionSpecs: { reasoningLevel: { values: ['high'] } } } },
  ]);
  assert.deepEqual(supportedEfforts('GLM-5.3', { builtinConfig: file }), ['low', 'medium', 'max']);
  assert.deepEqual(supportedEfforts('GLM-5.3-Flash', { builtinConfig: file }), ['low', 'medium', 'max']);
  assert.equal(effortProblem('GLM-5.3', 'high', { builtinConfig: file }), '--effort high is not supported by GLM-5.3 (supported: low, medium, max).');
  assert.equal(effortProblem('GLM-5.3', 'medium', { builtinConfig: file }), null);
});

test('unreadable or non-matching config falls back to the built-in table', () => {
  assert.deepEqual(supportedEfforts('GLM-5.3', { builtinConfig: path.join(fake.base, 'missing.json') }), ['low', 'high', 'max']);
  const noMatch = builtin('b2.json', [{ modelMatch: '.*other.*', config: { optionSpecs: { reasoningLevel: { values: ['low'] } } } }]);
  assert.deepEqual(supportedEfforts('GLM-5.3-Flash', { builtinConfig: noMatch }), ['low', 'high', 'max']);
  assert.deepEqual(modelLevels({ builtinConfig: noMatch }), { 'GLM-5.3': ['low', 'high', 'max'], 'GLM-5.3-Flash': ['low', 'high', 'max'] });
});

test('the real ZCode builtin config (when installed) gives GLM-5.3 and Flash low|high|max', { skip: !fs.existsSync('/Applications/ZCode.app/Contents/Resources/config/provider/zcode-builtin.json') }, () => {
  const file = '/Applications/ZCode.app/Contents/Resources/config/provider/zcode-builtin.json';
  assert.deepEqual(supportedEfforts('GLM-5.3', { builtinConfig: file }), ['low', 'high', 'max']);
  assert.deepEqual(supportedEfforts('GLM-5.3-Flash', { builtinConfig: file }), ['low', 'high', 'max']);
});

const run = (args, opts) => cli(args, { cwd: fake.work, timeoutMs: 60000, ...opts });

test('--effort medium is refused with exit 2 and one line, before any engine spawn', async () => {
  const r = await run(['task', '--effort', 'medium', '--id', 'e-1', 'Do it']);
  assert.equal(r.code, 2);
  assert.equal(r.stderr, 'zcode: --effort medium is not supported by GLM-5.3-Flash (supported: low, high, max).\n');
  assert.deepEqual(fake.log(), [], 'the engine was never spawned');
  assert.equal(require('../../lib/store.js').readSession('e-1'), null, 'no session record either');

  const r53 = await run(['run', '--model', 'glm-5.3', '--effort', 'xhigh', 'hi']);
  assert.equal(r53.code, 2);
  assert.match(r53.stderr, /--effort xhigh is not supported by GLM-5\.3 \(supported: low, high, max\)/);
  assert.deepEqual(fake.log(), []);
});

test('contract effort is validated too (JSON contract, with and without a --model override)', async () => {
  const file = path.join(fake.base, 'c.json');
  fs.writeFileSync(file, JSON.stringify({ objective: 'x', effort: 'medium' }));
  const r = await run(['task', '--task', file]);
  assert.equal(r.code, 2);
  assert.equal(r.stderr, 'zcode: contract effort medium is not supported by GLM-5.3-Flash (supported: low, high, max).\n');

  fs.writeFileSync(file, JSON.stringify({ objective: 'x', model: 'glm-5.3', effort: 'xhigh' }));
  const r2 = await run(['task', '--task', file]);
  assert.equal(r2.code, 2);
  assert.match(r2.stderr, /contract effort xhigh is not supported by GLM-5\.3 /);
  assert.deepEqual(fake.log(), []);

  // A flag overrides the contract's effort and is itself what gets validated.
  const ok = await run(['task', '--task', file, '--effort', 'high', '--json', '--quiet']);
  assert.notEqual(ok.code, 2, ok.stderr);
});

test('supported efforts still run; doctor --json lists models: {id: [levels]}', async () => {
  const ok = await run(['task', '--effort', 'high', '--quiet', '--json', 'Do it']);
  assert.notEqual(ok.code, 2, ok.stderr);
  assert.ok(fake.log().length > 0, 'the engine was spawned');

  const d = await run(['doctor', '--json']);
  assert.equal(d.code, 0, d.stderr);
  assert.deepEqual(JSON.parse(d.stdout).models, { 'GLM-5.3': ['low', 'high', 'max'], 'GLM-5.3-Flash': ['low', 'high', 'max'] });
});

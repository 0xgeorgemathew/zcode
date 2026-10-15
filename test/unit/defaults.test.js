'use strict';
// Every command defaults to GLM-5.3-Flash at effort max; --model / --effort override.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseArgv } = require('../../bin/zcode.js');

test('default model is GLM-5.3-Flash at effort max for run, task and agent', () => {
  for (const cmd of ['run', 'task', 'agent']) {
    const { flags } = parseArgv([cmd, 'x']);
    assert.equal(flags.model, 'GLM-5.3-Flash', cmd);
    assert.equal(flags.effort, 'max', cmd);
  }
});

test('--model and --effort override the defaults', () => {
  const { flags } = parseArgv(['task', '--model', 'glm-5.3', '--effort', 'low', 'x']);
  assert.equal(flags.model, 'GLM-5.3');
  assert.equal(flags.effort, 'low');
});

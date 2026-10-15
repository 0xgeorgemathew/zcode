'use strict';
// TDD step 1 — model allowlist rejection (offline: rejection precedes spawn).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { cli } = require('../helpers/env.js');

test('rejects --model gpt-4o with exit 2 naming the supported models', async () => {
  const { code, stdout, stderr } = await cli(['--model', 'gpt-4o', 'hi']);
  assert.equal(code, 2, `stderr: ${stderr}`);
  assert.match(stderr, /glm-5\.3/);
  assert.match(stderr, /glm-5\.3-flash/i);
  assert.equal(stdout, '');
});

test('rejects --model GLM-4.6 (a real legacy model) with exit 2', async () => {
  const { code, stdout, stderr } = await cli(['--model', 'GLM-4.6', 'hi']);
  assert.equal(code, 2, `stderr: ${stderr}`);
  assert.match(stderr, /glm-5\.3/);
  assert.match(stderr, /glm-5\.3-flash/i);
  assert.equal(stdout, '');
});

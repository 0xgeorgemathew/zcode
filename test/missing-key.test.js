'use strict';
// TDD step 2 — missing API key exits 3 with actionable message (offline:
// key resolution precedes any engine spawn).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { cli } = require('./helpers/env.js');

test('with no key anywhere, a run exits 3 mentioning login and ZAI_API_KEY', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'zcode-nokey-'));
  const { code, stdout, stderr } = await cli(['hi'], {
    env: { ZAI_CODE_HOME: home, ZAI_API_KEY: '' },
  });
  assert.equal(code, 3, `stderr: ${stderr}`);
  assert.match(stderr, /zcode login/);
  assert.match(stderr, /ZAI_API_KEY/);
  assert.equal(stdout, '');
});

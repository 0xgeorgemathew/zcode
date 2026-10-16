'use strict';
// TDD — session continuity (functional, live): a second CLI invocation with
// --session <id> continues the SAME conversation in a NEW engine process
// (sessions persist in the scratch HOME's SQLite store). Proves memory
// across processes: the word BANANA is only ever said in run 1.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { cli, checkEngine, loadEnvKey } = require('../helpers/env.js');

function preconditions() {
  const { engineOk } = checkEngine();
  assert.ok(engineOk, 'engine bundle must exist for the live test');
  assert.ok(loadEnvKey(), 'test API key must be loadable from .env');
}

test('LIVE --session: second process remembers the first turn', async () => {
  preconditions();
  const work = mkdtempSync(path.join(tmpdir(), 'zcode-session-'));
  try {
    let sessionId = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const { code, stdout, stderr } = await cli(
        ['--json', '--full', '--cwd', work, 'Remember the secret word BANANA. Reply with exactly: OK'],
        { cwd: work, timeoutMs: 240000 }
      ).catch((err) => ({ code: -1, stdout: '', stderr: String(err.message) }));
      if (code === 2 || code === 3 || code === 4) {
        assert.fail(`config error exit ${code}: ${stderr.trim()}`);
      }
      if (code === 0) {
        const result = JSON.parse(stdout.trim().split('\n').pop());
        if (result.ok && (result.response || '').trim() === 'OK' && result.sessionId) {
          sessionId = result.sessionId;
          break;
        }
      }
      if (attempt === 2) assert.fail(`first turn never passed: exit ${code} ${stderr.slice(0, 300)}`);
    }
    assert.match(sessionId, /^sess_/);

    let last;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const { code, stdout, stderr } = await cli(
        [
          '--json', '--full',
          '--session',
          sessionId,
          '--cwd',
          work,
          'Reply with only the secret word I told you earlier.',
        ],
        { cwd: work, timeoutMs: 240000 }
      ).catch((err) => ({ code: -1, stdout: '', stderr: String(err.message) }));
      if (code === 2 || code === 3 || code === 4) {
        assert.fail(`config error exit ${code}: ${stderr.trim()}`);
      }
      if (code === 0) {
        const result = JSON.parse(stdout.trim().split('\n').pop());
        if (result.ok && (result.response || '').trim() === 'BANANA') {
          assert.equal(result.sessionId, sessionId, 'same session continued');
          assert.equal(result.resumed, true, 'result marks the resumed turn');
          last = { pass: true };
          break;
        }
        last = { retryable: `response: ${JSON.stringify((result || {}).response).slice(0, 120)}` };
      } else {
        last = { retryable: `exit ${code}: ${stderr.trim().slice(0, 400)}` };
      }
      if (attempt === 1) {
        console.log(`[retry] ${last.retryable}`);
        continue;
      }
      assert.fail(`second turn failed: ${last.retryable}`);
    }
    assert.ok(last.pass);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

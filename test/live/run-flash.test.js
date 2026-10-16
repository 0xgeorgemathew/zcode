'use strict';
// TDD step 4 — REAL API, GLM-5.3-Flash, effort max, one-shot turn through the
// isolated scratch HOME (DESIGN §12 step 4). Wire-level facts are asserted
// from engine-side artifacts (model_request_started event), never from the
// wrapper's own echo. Determinism: trimmed-content compare, ONE retry on
// content mismatch / turn failure / timeout, never on config errors (2/3/4).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { cli, checkEngine, loadEnvKey } = require('../helpers/env.js');

const PROMPT = 'Reply with exactly the word OK and nothing else.';

function parseNdjson(stdout) {
  return stdout
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

// One attempt. Returns {pass} or {hardFail} or {retryable, why}.
function evaluate({ code, stdout, stderr }) {
  if (code === 2 || code === 3 || code === 4) {
    return { hardFail: `config error exit ${code}: ${stderr.trim()}` };
  }
  if (code !== 0) {
    return {
      retryable: `exit ${code}: ${stderr.trim().slice(0, 500)} | tail(stdout): ${stdout.trim().split('\n').slice(-3).join(' / ').slice(0, 300)}`,
    };
  }
  let events;
  try {
    events = parseNdjson(stdout);
  } catch (err) {
    return { retryable: `stdout not NDJSON: ${err.message}` };
  }
  const result = events[events.length - 1];
  if (!result || result.type !== 'result') {
    return { retryable: 'final stdout line is not a result frame' };
  }
  if ((result.response || '').trim() !== 'OK') {
    return { retryable: `response mismatch: ${JSON.stringify(result.response).slice(0, 200)}` };
  }
  return { pass: { result, events } };
}

test('Flash one-shot: OK, model+effort on the wire, yolo mode, usage, streaming', async () => {
  const { engineOk } = checkEngine();
  assert.ok(engineOk, 'engine bundle must exist for the live test');
  assert.ok(loadEnvKey(), 'test API key must be loadable from .env');

  const work = mkdtempSync(path.join(tmpdir(), 'zcode-flash-'));
  let last;
  try {
    for (let attempt = 1; attempt <= 2; attempt++) {
      const { code, stdout, stderr } = await cli(['--json', '--full', '--cwd', work, PROMPT], {
        cwd: work,
        timeoutMs: 240000,
      }).catch((err) => ({ code: -1, stdout: '', stderr: String(err.message) }));
      last = evaluate({ code, stdout, stderr });
      if (last.hardFail) assert.fail(last.hardFail);
      if (last.pass) break;
      if (attempt === 1) {
        console.log(`[retry] ${last.retryable}`);
        continue;
      }
      assert.fail(`second attempt failed: ${last.retryable}`);
    }

    const { result, events } = last.pass;
    assert.equal(result.ok, true);
    assert.equal(result.response.trim(), 'OK');
    assert.equal(result.model, 'GLM-5.3-Flash');
    assert.equal(result.effort, 'max');
    assert.match(result.sessionId, /^sess_/);
    assert.equal(result.mode, 'yolo', 'session must run in yolo mode (permission story)');
    assert.ok(result.usage.outputTokens > 0, 'usage.outputTokens > 0');

    // Wire-level cross-checks against engine-side artifacts, not the echo.
    const started = events.filter((e) => e.type === 'model_request_started');
    assert.ok(started.length >= 1, '>=1 model_request_started event in --json stream');
    for (const e of started) {
      assert.equal(e.modelId, 'GLM-5.3-Flash', 'engine-reported model id');
      assert.equal(e.providerId, 'zai-api', 'engine-reported provider id');
    }
    const stateFrames = events.filter((e) => e.type === 'state');
    // Engine 0.16.9 no longer broadcasts state.updated for the mode on a fresh
    // session (result.mode above is the session's own report). When a frame
    // does arrive it must say yolo.
    for (const f of stateFrames) assert.equal(f.mode, 'yolo', 'engine-broadcast mode must be yolo');

    const streams = events.filter((e) => e.type === 'stream');
    assert.ok(streams.length >= 1, '>=1 model.streaming event streamed');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

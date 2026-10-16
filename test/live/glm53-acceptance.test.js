'use strict';
// TDD step 7 — THE single GLM-5.3 acceptance run (DESIGN §12 step 7). The
// only test in the suite allowed to run GLM-5.3. Model evidence is
// engine-side (model_request_started event), not the wrapper's echo.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { cli, checkEngine, loadEnvKey } = require('../helpers/env.js');

const PROMPT = 'Reply with exactly the word OK and nothing else.';

test('glm-5.3 one-shot acceptance: OK, model cross-checked on the wire', async () => {
  const { engineOk } = checkEngine();
  assert.ok(engineOk, 'engine bundle must exist for the live test');
  assert.ok(loadEnvKey(), 'test API key must be loadable from .env');

  const work = mkdtempSync(path.join(tmpdir(), 'zcode-glm53-'));
  let last;
  try {
    for (let attempt = 1; attempt <= 2; attempt++) {
      const { code, stdout, stderr } = await cli(
        ['--model', 'glm-5.3', '--json', '--full', '--cwd', work, PROMPT],
        { cwd: work, timeoutMs: 300000 }
      ).catch((err) => ({ code: -1, stdout: '', stderr: String(err.message) }));
      if (code === 2 || code === 3 || code === 4) {
        assert.fail(`config error exit ${code}: ${stderr.trim()}`);
      }
      let events;
      try {
        events = stdout.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
      } catch (err) {
        if (attempt === 1) continue;
        assert.fail(`stdout not NDJSON: ${err.message}`);
      }
      const result = events[events.length - 1];
      const pass =
        code === 0 &&
        result?.type === 'result' &&
        result.ok &&
        (result.response || '').trim() === 'OK';
      if (pass) {
        last = { result, events };
        break;
      }
      const why = `exit ${code}: ${stderr.trim().slice(0, 300)} | ${JSON.stringify(result).slice(0, 300)}`;
      if (attempt === 1) {
        console.log(`[retry] ${why}`);
        continue;
      }
      assert.fail(`second attempt failed: ${why}`);
    }

    const { result, events } = last;
    assert.equal(result.response.trim(), 'OK');
    assert.equal(result.model, 'GLM-5.3');
    assert.equal(result.mode, 'yolo');

    const started = events.filter((e) => e.type === 'model_request_started');
    assert.ok(started.length >= 1, 'engine reported the model request');
    for (const e of started) {
      assert.equal(e.modelId, 'GLM-5.3', 'engine-reported model is GLM-5.3');
      assert.equal(e.providerId, 'zai-api');
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

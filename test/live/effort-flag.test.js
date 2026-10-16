'use strict';
// TDD step 5 — REAL API (Flash): --effort high must reach the WIRE, asserted
// from the engine-side rollout capture (DESIGN §12 step 5). Field name pinned
// live this session: request.body.output_config.effort ({"effort":"max"} on a
// max run vs {"effort":"high"} on a high run; body also carries
// thinking:{type:"enabled"} and max_tokens). Also: unknown effort values are
// usage errors (exit 2) before any spawn.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  readFileSync,
  existsSync,
  mkdtempSync,
  rmSync,
  readdirSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { cli, checkEngine, loadEnvKey } = require('../helpers/env.js');

// 0.4: each zcode session has its own engine HOME under
// <root>/sessions/<id>/home; the rollout capture lives there.
function rolloutDir(id) {
  return path.join(
    process.env.ZAI_CODE_HOME || path.join(require('node:os').homedir(), '.zcode-cli'),
    'sessions',
    id,
    'home',
    '.zcode',
    'cli',
    'rollout'
  );
}

const PROMPT = 'Reply with exactly the word OK and nothing else.';

function rolloutRecords(id, sessionId) {
  const file = path.join(rolloutDir(id), `model-io-${sessionId}.jsonl`);
  const text = readFileSync(file, 'utf8');
  return text
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

// The engine flushes the rollout capture around turn completion; poll briefly.
function rolloutFor(id, sessionId, { timeoutMs = 10000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const records = rolloutRecords(id, sessionId);
      if (records.length > 0) return records;
    } catch (err) {
      lastErr = err;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
  throw lastErr || new Error(`no rollout capture for ${sessionId}`);
}

test('--effort bogus is a usage error before any spawn', async () => {
  const { code, stdout, stderr } = await cli(['--effort', 'turbo', 'hi']);
  assert.equal(code, 2, `stderr: ${stderr}`);
  assert.match(stderr, /effort/i);
  assert.equal(stdout, '');
});

test('--effort high lands on the wire (rollout output_config.effort)', async () => {
  const { engineOk } = checkEngine();
  assert.ok(engineOk, 'engine bundle must exist for the live test');
  assert.ok(loadEnvKey(), 'test API key must be loadable from .env');

  const work = mkdtempSync(path.join(tmpdir(), 'zcode-effort-'));
  let outcome;
  try {
    for (let attempt = 1; attempt <= 2; attempt++) {
      const { code, stdout, stderr } = await cli(
        ['--effort', 'high', '--json', '--full', '--cwd', work, PROMPT],
        { cwd: work, timeoutMs: 240000 }
      ).catch((err) => ({ code: -1, stdout: '', stderr: String(err.message) }));
      if (code === 2 || code === 3 || code === 4) {
        assert.fail(`config error exit ${code}: ${stderr.trim()}`);
      }
      let result;
      try {
        const lines = stdout.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
        result = lines[lines.length - 1];
      } catch (err) {
        if (attempt === 1) continue;
        assert.fail(`stdout not NDJSON: ${err.message}`);
      }
      if (code === 0 && result?.ok && result.response?.trim() === 'OK') {
        outcome = result;
        break;
      }
      if (attempt === 1) {
        console.log(`[retry] exit ${code} result=${JSON.stringify(result).slice(0, 200)} stderr=${stderr.slice(0, 200)}`);
        continue;
      }
      assert.fail(`second attempt failed: exit ${code}, ${JSON.stringify(result).slice(0, 300)}`);
    }

    assert.equal(outcome.model, 'GLM-5.3-Flash');
    assert.equal(outcome.effort, 'high');

    // Wire-level assertion from the engine's own request capture.
    const records = rolloutFor(outcome.id, outcome.sessionId);
    assert.ok(records.length >= 1, 'rollout capture has >=1 model_io record');
    for (const rec of records) {
      const body = rec.request && rec.request.body;
      assert.ok(body, 'record carries a request body');
      assert.equal(body.model, 'GLM-5.3-Flash', 'wire model id');
      assert.equal(
        body.output_config && body.output_config.effort,
        'high',
        'wire output_config.effort === high'
      );
      assert.equal(body.thinking && body.thinking.type, 'enabled', 'thinking enabled on the wire');
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

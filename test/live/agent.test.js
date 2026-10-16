'use strict';
// TDD step 6 — REAL API + real work (Flash, yolo-gated): `agent` dispatches a
// subagent that creates a file inside --cwd; verified programmatically via
// session/subagents joined with the scratch agents dir, plus the artifact
// itself (DESIGN §12 step 6). One retry budget for content mismatch / turn
// failure / timeout; never for config errors.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, existsSync, mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { cli, checkEngine, loadEnvKey } = require('../helpers/env.js');

const PROMPT =
  'Use the Agent tool to create the file hello.txt in the current directory containing exactly HELLO-SUBAGENT, then report the agent id.';

test('agent dispatches a subagent that does real work inside --cwd', async () => {
  const { engineOk } = checkEngine();
  assert.ok(engineOk, 'engine bundle must exist for the live test');
  assert.ok(loadEnvKey(), 'test API key must be loadable from .env');

  const work = mkdtempSync(path.join(tmpdir(), 'zcode-agent-'));
  try {
    let result = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const { code, stdout, stderr } = await cli(
        [
          'agent', '--json', '--full', '--cwd', work, '--profile', 'general-purpose', PROMPT,
        ],
        { cwd: work, timeoutMs: 420000 }
      ).catch((err) => ({ code: -1, stdout: '', stderr: String(err.message) }));
      if (code === 2 || code === 3 || code === 4) {
        assert.fail(`config error exit ${code}: ${stderr.trim()}`);
      }
      let parsed;
      try {
        const lines = stdout.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
        parsed = lines[lines.length - 1];
      } catch (err) {
        if (attempt === 1) continue;
        assert.fail(`stdout not NDJSON: ${err.message}`);
      }
      if (code === 0 && parsed?.type === 'result' && parsed.ok) {
        result = parsed;
        break;
      }
      const why =
        code === 6
          ? `no successful subagent (exit 6): ${JSON.stringify(parsed).slice(0, 400)}`
          : `exit ${code}: ${stderr.trim().slice(0, 300)} | ${JSON.stringify(parsed).slice(0, 300)}`;
      if (attempt === 1) {
        console.log(`[retry] ${why}`);
        continue;
      }
      assert.fail(`second attempt failed: ${why}`);
    }

    // yolo gates the permission story (§9.1).
    assert.equal(result.mode, 'yolo', 'agent run must be yolo');
    assert.ok(result.response && result.response.trim().length > 0, 'parent response non-empty');

    // Programmatic subagent verification.
    assert.ok(Array.isArray(result.subagents), 'result.subagents is an array');
    assert.ok(result.subagents.length >= 1, 'at least one subagent dispatched');
    for (const sa of result.subagents) {
      assert.equal(sa.status, 'success', `subagent ${sa.agentId} status success`);
      assert.ok(sa.agentId, 'subagent carries agentId');
      assert.ok(sa.childSessionId, 'subagent carries childSessionId');
    }

    // The artifact: real work inside the session cwd, exact content.
    const artifact = path.join(work, 'hello.txt');
    assert.ok(existsSync(artifact), 'hello.txt created inside --cwd');
    const content = readFileSync(artifact, 'utf8');
    // Content-exact modulo a trailing newline — models routinely add one.
    assert.equal(content.replace(/\n$/, ''), 'HELLO-SUBAGENT', `exact content, got ${JSON.stringify(content)}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

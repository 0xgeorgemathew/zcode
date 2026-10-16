'use strict';
// TDD — MCP support (functional): a REAL stdio MCP server fixture, plus
// usage-level checks. The live test proves the whole chain: --mcp registers
// the server, the engine spawns it, and the model calls its tool — PAPAYA
// exists nowhere else, so a match is proof of a real round-trip.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { cli, checkEngine, loadEnvKey } = require('../helpers/env.js');

const FIXTURE_SERVER = path.join(__dirname, '..', 'fixtures', 'mcp-word-server.js');

function wordServerSpec() {
  return JSON.stringify({
    'word-server': {
      type: 'stdio',
      command: process.execPath,
      args: [FIXTURE_SERVER],
      enabled: true,
    },
  });
}

test('--mcp with invalid JSON exits 2 before any engine spawn', async () => {
  const { code, stdout, stderr } = await cli(['--mcp', '{not json', 'hi'], {
    timeoutMs: 60000,
  });
  assert.equal(code, 2);
  assert.match(stderr, /--mcp[^]*valid JSON/, 'must name --mcp and say why');
  assert.equal(stdout, '');
});

test('--mcp-list prints the effective server set including the added server', async () => {
  const { code, stdout, stderr } = await cli(['--mcp', wordServerSpec(), '--mcp-list'], {
    timeoutMs: 120000,
  });
  assert.equal(code, 0, stderr.trim());
  const parsed = JSON.parse(stdout.trim().split('\n').pop());
  assert.equal(parsed.type, 'mcp');
  assert.ok(parsed.servers && typeof parsed.servers === 'object');
  assert.ok(parsed.servers['word-server'], 'added server must be listed');
  assert.equal(parsed.servers['word-server'].type, 'stdio');
});

test('default MCP set is hermetic (only the desktop playwright browser; --no-browser: empty); --mcp-inherit lists the desktop servers', async () => {
  const hermetic = await cli(['--mcp-list'], { timeoutMs: 120000 });
  assert.equal(hermetic.code, 0, hermetic.stderr.trim());
  const dflt = JSON.parse(hermetic.stdout.trim().split('\n').pop());
  assert.deepEqual(Object.keys(dflt.servers), ['playwright'], 'no --mcp/--mcp-inherit: only the browser server');

  const bare = await cli(['--no-browser', '--mcp-list'], { timeoutMs: 120000 });
  assert.equal(bare.code, 0, bare.stderr.trim());
  const empty = JSON.parse(bare.stdout.trim().split('\n').pop());
  assert.deepEqual(empty.servers, {}, '--no-browser and no --mcp/--mcp-inherit means no servers');

  const inherited = await cli(['--mcp-inherit', '--mcp-list'], { timeoutMs: 120000 });
  assert.equal(inherited.code, 0, inherited.stderr.trim());
  const set = JSON.parse(inherited.stdout.trim().split('\n').pop());
  assert.ok(Object.keys(set.servers).length >= 1, 'desktop has enabled servers to inherit');
});

// LIVE. One retry on content mismatch / turn failure / timeout, never on
// config errors (exit 2/3/4), matching the suite's determinism policy.
test('LIVE --mcp: engine spawns the server and the model calls its tool', async () => {
  const { engineOk } = checkEngine();
  assert.ok(engineOk, 'engine bundle must exist for the live test');
  assert.ok(loadEnvKey(), 'test API key must be loadable from .env');

  const work = mkdtempSync(path.join(tmpdir(), 'zcode-mcp-'));
  const prompt =
    'Call the get_magic_word tool from the word-server MCP server, then reply with exactly the word it returns and nothing else.';
  try {
    let last;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const { code, stdout, stderr } = await cli(
        ['--json', '--full', '--mcp', wordServerSpec(), '--cwd', work, prompt],
        { cwd: work, timeoutMs: 420000 }
      ).catch((err) => ({ code: -1, stdout: '', stderr: String(err.message) }));
      if (code === 2 || code === 3 || code === 4) {
        assert.fail(`config error exit ${code}: ${stderr.trim()}`);
      }
      if (code === 0) {
        const events = stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
        const result = events[events.length - 1];
        if (result.ok && (result.response || '').trim() === 'PAPAYA') {
          last = { pass: result };
          break;
        }
        const mcpEvents = events.filter((e) => e.type === 'mcp').map((e) => `${e.name}:${e.status}`).join(' ');
        last = {
          retryable: `response mismatch: ${JSON.stringify(result.response).slice(0, 150)} [mcp events: ${mcpEvents || 'none'}]`,
        };
      } else {
        last = { retryable: `exit ${code}: ${stderr.trim().slice(0, 400)}` };
      }
      if (attempt === 1) {
        console.log(`[retry] ${last.retryable}`);
        continue;
      }
      assert.fail(`second attempt failed: ${last.retryable}`);
    }
    assert.ok(last.pass, 'must have a passing attempt');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

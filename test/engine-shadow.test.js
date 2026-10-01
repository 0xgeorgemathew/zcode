'use strict';
// TDD — 0.3.0 regression: the globally installed `zcode` wrapper sits on
// PATH, and the engine resolver's PATH probe accepted ANY file named
// `zcode` as the engine — self-shadowing (builtin config then resolved to
// /opt/homebrew/config/provider/... and every command exited 4). The
// resolver must skip its own binary and only accept real zcode.cjs
// bundles from PATH/home candidates. No API call: doctor resolves the
// engine locally and spawns it once for the version.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync, symlinkSync, realpathSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { cli, checkEngine, binPath, loadEnvKey } = require('./helpers/env.js');

test('a zcode wrapper on PATH must not be taken for the engine (0.3.0 regression)', async () => {
  const { engineOk } = checkEngine();
  assert.ok(engineOk, 'engine bundle must exist for this test');
  assert.ok(loadEnvKey(), 'test API key must be loadable from .env');

  // Fake PATH dir whose `zcode` is a symlink to our own bin, exactly how
  // `npm install -g` installs it.
  const fakeBin = mkdtempSync(path.join(tmpdir(), 'zcode-shadow-'));
  try {
    symlinkSync(binPath, path.join(fakeBin, 'zcode'), 'file');
    const { code, stdout, stderr } = await cli(['doctor', '--json'], {
      env: {
        PATH: fakeBin + path.delimiter + process.env.PATH,
        ZAI_CODE_ENGINE: '',
      },
      timeoutMs: 120000,
    });
    assert.equal(code, 0, `must not exit 4 (builtin config not found): ${stderr.trim().slice(0, 300)}`);
    const report = JSON.parse(stdout.trim().split('\n').pop());
    assert.match(
      report.engine.path,
      /zcode\.cjs$/,
      'resolved engine must be a real zcode.cjs bundle, not the wrapper'
    );
    assert.notEqual(report.engine.path, realpathSync(binPath));
    assert.equal(report.isolation.mcpServersInherited, report.isolation.mcpServersInherited); // shape intact
  } finally {
    rmSync(fakeBin, { recursive: true, force: true });
  }
});

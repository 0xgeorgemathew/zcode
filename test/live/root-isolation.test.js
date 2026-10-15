'use strict';
// TDD — 0.3.0/0.3.1 regression: the package rename made the CLI's own
// root literally equal the desktop app's live directory (~/.zcode), so
// `zcode login` and the scratch HOME wrote straight into the live config.
// Two guards: a pure invariant (root must never be the live dir or inside
// it) and a real migration under a fake HOME (our four artifacts vacate
// the live dir; everything else in it is untouched). No API call.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { cli, checkEngine, loadEnvKey } = require('../helpers/env.js');

test('CLI root is never the live ~/.zcode and never inside it', () => {
  const { rootDir, LIVE_ZCODE } = require('../lib/isolation.js');
  const root = rootDir({});
  assert.notEqual(root, LIVE_ZCODE, 'root must not equal the live dir');
  assert.ok(
    !root.startsWith(LIVE_ZCODE + path.sep),
    'root must not live inside the live dir'
  );
  assert.ok(!root.endsWith('/.zcode'), 'root must not be ~/.zcode itself');
  assert.equal(
    rootDir({ ZAI_CODE_HOME: '/tmp/custom-root' }),
    '/tmp/custom-root',
    'env override still wins'
  );
});

test('migration vacates our artifacts from the live dir and touches nothing else', async () => {
  const { engineOk } = checkEngine();
  assert.ok(engineOk, 'engine bundle must exist for this test');
  assert.ok(loadEnvKey(), 'test API key must be loadable from .env');

  // A fake HOME whose ~/.zcode plays the desktop live dir: our four
  // artifacts polluting it (as 0.3.0/0.3.1 left them) plus a sentinel
  // file and dir that belong to the desktop and must survive untouched.
  const fakeHome = mkdtempSync(path.join(tmpdir(), 'zcode-migrate-'));
  const fakeLive = path.join(fakeHome, '.zcode');
  mkdirSync(path.join(fakeLive, 'cli'), { recursive: true });
  writeFileSync(path.join(fakeLive, 'AGENTS.md'), '# desktop file, not ours\n');
  writeFileSync(path.join(fakeLive, 'cli', 'config.json'), '{}\n');
  writeFileSync(path.join(fakeLive, 'credentials.json'), '{"apiKey":"stored-by-login"}\n');
  writeFileSync(path.join(fakeLive, 'build-stamp.json'), '{"version":1}\n');
  writeFileSync(path.join(fakeLive, 'injected-skills.json'), '{"skills":[]}\n');
  mkdirSync(path.join(fakeLive, 'home', '.zcode'), { recursive: true });
  writeFileSync(path.join(fakeLive, 'home', '.zcode', 'marker'), 'scratch\n');

  try {
    const { code, stdout, stderr } = await cli(['doctor', '--json'], {
      env: { HOME: fakeHome },
      timeoutMs: 120000,
    });
    assert.equal(code, 0, stderr.trim().slice(0, 400));

    const newRoot = path.join(fakeHome, '.zcode-cli');
    // Our artifacts moved to the new root.
    assert.ok(existsSync(path.join(newRoot, 'credentials.json')), 'key file migrated');
    assert.equal(
      readFileSync(path.join(newRoot, 'credentials.json'), 'utf8'),
      '{"apiKey":"stored-by-login"}\n',
      'migrated key content intact'
    );
    // The legacy shared home moves too (0.4 only mines it for shared caches).
    assert.ok(existsSync(path.join(newRoot, 'home')), 'legacy scratch home migrated');
    assert.ok(existsSync(path.join(newRoot, 'build-stamp.json')), 'stamp migrated');
    // And gone from the live dir.
    for (const name of ['credentials.json', 'build-stamp.json', 'injected-skills.json', 'home']) {
      assert.ok(
        !existsSync(path.join(fakeLive, name)),
        `${name} must be vacated from the live dir`
      );
    }
    // Desktop-owned content untouched.
    assert.ok(existsSync(path.join(fakeLive, 'AGENTS.md')), 'desktop AGENTS.md untouched');
    assert.ok(existsSync(path.join(fakeLive, 'cli', 'config.json')), 'desktop cli config untouched');

    const report = JSON.parse(stdout.trim().split('\n').pop());
    assert.equal(report.isolation.root, newRoot, 'doctor reports the new root');
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

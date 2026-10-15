'use strict';
// TDD step 8 — packaging guard (offline, but it guards a real security
// property: the repo holds .env with a live key). Asserts the tarball ships
// ONLY bin/, lib/, README.md, LICENSE, package.json — never .env, test/, or
// DESIGN.md — and that no shipped file CONTAINS the key material.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, rmSync, mkdirSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { loadEnvKey, repoRoot } = require('../helpers/env.js');

const ALLOWED_ROOTS = new Set([
  'skills',
  'bin',
  'lib',
  'README.md',
  'LICENSE',
  'package.json',
]);

test('npm pack ships only the allowlist and no key material', () => {
  const dest = mkdtempSync(path.join(tmpdir(), 'zcode-pack-'));
  try {
    const raw = execFileSync('npm', ['pack', '--json', '--pack-destination', dest], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, CI: 'true' },
    });
    const manifest = JSON.parse(raw);
    const tarball = path.join(dest, manifest[0].filename);
    const listing = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' });

    const paths = listing
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => l.replace(/^package\//, ''))
      .filter((p) => p.length > 0 && !p.endsWith('/'));

    assert.ok(paths.includes('bin/zcode.js'), 'bin entry ships');
    assert.ok(paths.includes('README.md'), 'README ships');
    assert.ok(paths.includes('LICENSE'), 'LICENSE ships');
    assert.ok(paths.includes('package.json'), 'package.json ships');

    const offenders = paths.filter((p) => {
      const top = p.split('/')[0];
      return !ALLOWED_ROOTS.has(top);
    });
    assert.deepEqual(offenders, [], `only allowlisted roots may ship: ${offenders.join(', ')}`);

    assert.ok(!paths.some((p) => p === '.env' || p.endsWith('/.env')), '.env must not ship');
    assert.ok(!paths.some((p) => p.startsWith('test/')), 'test/ must not ship');
    assert.ok(!paths.some((p) => p === 'DESIGN.md'), 'DESIGN.md must not ship');

    // Content-level guard: extract and scan every shipped file for the live
    // key value (filenames only in failures — the key is never printed).
    const extractDir = path.join(dest, 'x');
    mkdirSync(extractDir, { recursive: true });
    execFileSync('tar', ['-xzf', tarball, '-C', extractDir], { cwd: dest });
    const key = loadEnvKey();
    assert.ok(key, 'test API key must be loadable for the content scan');
    const { execSync } = require('node:child_process');
    let hits = '';
    try {
      hits = execSync(`grep -rlF ${JSON.stringify(key)} ${JSON.stringify(extractDir)}`, {
        encoding: 'utf8',
      });
    } catch {
      hits = ''; // grep exit 1 = no matches = what we want
    }
    assert.equal(hits.trim(), '', 'no shipped file may contain the API key');
  } finally {
    rmSync(dest, { recursive: true, force: true });
  }
});

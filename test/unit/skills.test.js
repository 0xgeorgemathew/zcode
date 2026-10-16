'use strict';
// `zcode skills` installs, reports and removes both skills in a fake HOME /
// CODEX_HOME (no CLI spawn). Nothing is installed at npm install time.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { installSkills, uninstallSkills, skillStatus } = require('../../lib/skills.js');
const { parseArgv } = require('../../bin/zcode.js');

test('package.json runs no install scripts', () => {
  const pkg = require('../../package.json');
  for (const s of ['preinstall', 'install', 'postinstall']) assert.equal(pkg.scripts[s], undefined, s);
});

test('install copies both skills, replacing stale copies; uninstall removes them', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-skills-'));
  const env = { HOME: base, CODEX_HOME: path.join(base, 'codex') };
  try {
    const stale = path.join(base, '.claude', 'skills', 'zcode', 'old.md');
    fs.mkdirSync(path.dirname(stale), { recursive: true });
    fs.writeFileSync(stale, 'x');
    assert.equal(installSkills({ env }).length, 2);
    assert.ok(fs.existsSync(path.join(base, '.claude', 'skills', 'zcode', 'SKILL.md')));
    assert.ok(!fs.existsSync(stale));
    assert.ok(fs.existsSync(path.join(base, 'codex', 'skills', 'zcode', 'agents', 'openai.yaml')));
    assert.deepEqual(skillStatus({ env }).map((t) => t.installed), [true, true]);

    assert.deepEqual(uninstallSkills({ platforms: ['codex'], env }).map((t) => t.platform), ['codex']);
    assert.deepEqual(skillStatus({ env }).map((t) => t.installed), [true, false]);
    assert.ok(fs.existsSync(path.join(base, 'codex', 'skills')), 'only the zcode dir is removed');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('install can target one platform', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-skills-'));
  const env = { HOME: base, CODEX_HOME: path.join(base, 'codex') };
  try {
    assert.deepEqual(installSkills({ platforms: ['claude'], env }).map((t) => t.platform), ['claude']);
    assert.ok(!fs.existsSync(path.join(base, 'codex')));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('zcode skills parses as a command with its arguments', () => {
  const { command, prompts } = parseArgv(['skills', 'install', 'claude']);
  assert.equal(command, 'skills');
  assert.deepEqual(prompts, ['install', 'claude']);
});

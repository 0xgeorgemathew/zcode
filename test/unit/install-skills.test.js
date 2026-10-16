'use strict';
// postinstall copies both skills into a fake HOME / CODEX_HOME (no CLI spawn).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('installSkills copies the Claude Code and Codex skills, replacing stale copies', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-skills-'));
  const saved = process.env.HOME;
  process.env.HOME = base;
  try {
    const { installSkills } = require('../../lib/install-skills.js');
    const env = { CODEX_HOME: path.join(base, 'codex') };
    const stale = path.join(base, '.claude', 'skills', 'zcode', 'old.md');
    fs.mkdirSync(path.dirname(stale), { recursive: true });
    fs.writeFileSync(stale, 'x');
    const done = installSkills(env);
    assert.equal(done.length, 2);
    assert.ok(fs.existsSync(path.join(base, '.claude', 'skills', 'zcode', 'SKILL.md')));
    assert.ok(!fs.existsSync(stale));
    assert.ok(fs.existsSync(path.join(base, 'codex', 'skills', 'zcode', 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(base, 'codex', 'skills', 'zcode', 'agents', 'openai.yaml')));
  } finally {
    process.env.HOME = saved;
    fs.rmSync(base, { recursive: true, force: true });
  }
});

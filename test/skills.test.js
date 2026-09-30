'use strict';
// TDD — skills support (functional): a REAL skill (SKILL.md frontmatter +
// body) injected per-run with --skills. The live test proves the model can
// load it via the Skill tool — BLUEBERRY exists only inside the fixture
// skill, so a match is proof the skill was really available to the session.
// Inheritance of the live ~/.zcode/skills into the scratch HOME is asserted
// structurally (no API call): doctor reports the copied skill count.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync, readdirSync, existsSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const os = require('node:os');
const { cli, checkEngine, loadEnvKey } = require('./helpers/env.js');

const FIXTURE_SKILLS = path.join(__dirname, 'fixtures', 'skills');

test('doctor reports skills inherited from the live ~/.zcode/skills', async () => {
  const liveSkills = path.join(os.homedir(), '.zcode', 'skills');
  let liveCount = 0;
  try {
    liveCount = readdirSync(liveSkills, { withFileTypes: true }).filter(
      (d) => d.isDirectory() && existsSync(path.join(liveSkills, d.name, 'SKILL.md'))
    ).length;
  } catch {
    liveCount = 0;
  }
  assert.ok(liveCount >= 1, 'this machine has live skills to inherit');

  const { code, stdout, stderr } = await cli(['doctor', '--json'], { timeoutMs: 120000 });
  assert.equal(code, 0, stderr.trim());
  const report = JSON.parse(stdout.trim().split('\n').pop());
  assert.ok(report.isolation, 'doctor reports isolation facts');
  assert.equal(typeof report.isolation.skillsCopied, 'number');
  assert.ok(
    report.isolation.skillsCopied >= 1,
    `skills copied into scratch (live has ${liveCount})`
  );
});

// LIVE. One retry on content mismatch / turn failure / timeout, never on
// config errors (exit 2/3/4).
test('LIVE --skills: model loads the injected skill via the Skill tool', async () => {
  const { engineOk } = checkEngine();
  assert.ok(engineOk, 'engine bundle must exist for the live test');
  assert.ok(loadEnvKey(), 'test API key must be loadable from .env');

  const work = mkdtempSync(path.join(tmpdir(), 'zcode-skills-'));
  const prompt =
    'Load the skill named word-vault using the Skill tool, then reply with exactly the magic word it reveals and nothing else.';
  try {
    let last;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const { code, stdout, stderr } = await cli(
        ['--json', '--skills', FIXTURE_SKILLS, '--cwd', work, prompt],
        { cwd: work, timeoutMs: 300000 }
      ).catch((err) => ({ code: -1, stdout: '', stderr: String(err.message) }));
      if (code === 2 || code === 3 || code === 4) {
        assert.fail(`config error exit ${code}: ${stderr.trim()}`);
      }
      if (code === 0) {
        const result = JSON.parse(stdout.trim().split('\n').pop());
        if (result.ok && (result.response || '').trim() === 'BLUEBERRY') {
          last = { pass: result };
          break;
        }
        last = { retryable: `response mismatch: ${JSON.stringify(result.response).slice(0, 200)}` };
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

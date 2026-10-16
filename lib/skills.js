'use strict';
// The orchestrator skills shipped in the package, and where `zcode skills`
// installs them:
//
//   skills/claude-code/zcode  ->  ~/.claude/skills/zcode
//   skills/codex/zcode        ->  ${CODEX_HOME:-~/.codex}/skills/zcode
//
// Only the zcode skill directory is ever replaced or removed.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const pkgRoot = path.join(__dirname, '..');
const PLATFORMS = ['claude', 'codex'];

function targets(env = process.env) {
  const home = env.HOME || os.homedir();
  return [
    {
      platform: 'claude',
      name: 'Claude Code',
      from: path.join(pkgRoot, 'skills', 'claude-code', 'zcode'),
      to: path.join(home, '.claude', 'skills', 'zcode'),
    },
    {
      platform: 'codex',
      name: 'Codex',
      from: path.join(pkgRoot, 'skills', 'codex', 'zcode'),
      to: path.join(env.CODEX_HOME || path.join(home, '.codex'), 'skills', 'zcode'),
    },
  ];
}

function select(platforms, env) {
  const want = platforms && platforms.length ? new Set(platforms) : new Set(PLATFORMS);
  return targets(env).filter((t) => want.has(t.platform));
}

function installSkills({ platforms, env = process.env } = {}) {
  const done = [];
  for (const t of select(platforms, env)) {
    fs.mkdirSync(path.dirname(t.to), { recursive: true });
    fs.rmSync(t.to, { recursive: true, force: true });
    fs.cpSync(t.from, t.to, { recursive: true });
    done.push(t);
  }
  return done;
}

function uninstallSkills({ platforms, env = process.env } = {}) {
  const done = [];
  for (const t of select(platforms, env)) {
    if (!fs.existsSync(t.to)) continue;
    fs.rmSync(t.to, { recursive: true, force: true });
    done.push(t);
  }
  return done;
}

function skillStatus({ env = process.env } = {}) {
  return targets(env).map((t) => ({ ...t, installed: fs.existsSync(path.join(t.to, 'SKILL.md')) }));
}

module.exports = { installSkills, uninstallSkills, skillStatus, targets, PLATFORMS };

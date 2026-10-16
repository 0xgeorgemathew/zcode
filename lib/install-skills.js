#!/usr/bin/env node
'use strict';
// postinstall: copy the orchestrator skills into Claude Code and Codex.
//
//   skills/claude-code/zcode  ->  ~/.claude/skills/zcode
//   skills/codex/zcode        ->  ${CODEX_HOME:-~/.codex}/skills/zcode
//
// Only the zcode skill directory is replaced; nothing else is touched.
// Skipped inside the source checkout (a .git next to package.json) and when
// ZCODE_SKIP_SKILLS=1. Never fails the install: errors become one warning.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const pkgRoot = path.join(__dirname, '..');

function targets(env = process.env) {
  const home = os.homedir();
  return [
    {
      name: 'Claude Code',
      from: path.join(pkgRoot, 'skills', 'claude-code', 'zcode'),
      to: path.join(home, '.claude', 'skills', 'zcode'),
    },
    {
      name: 'Codex',
      from: path.join(pkgRoot, 'skills', 'codex', 'zcode'),
      to: path.join(env.CODEX_HOME || path.join(home, '.codex'), 'skills', 'zcode'),
    },
  ];
}

function installSkills(env = process.env) {
  const done = [];
  for (const t of targets(env)) {
    if (!fs.existsSync(t.from)) continue;
    fs.mkdirSync(path.dirname(t.to), { recursive: true });
    fs.rmSync(t.to, { recursive: true, force: true });
    fs.cpSync(t.from, t.to, { recursive: true });
    done.push(t);
  }
  return done;
}

if (require.main === module) {
  if (process.env.ZCODE_SKIP_SKILLS === '1' || fs.existsSync(path.join(pkgRoot, '.git'))) process.exit(0);
  try {
    for (const t of installSkills()) console.log(`zcode: installed ${t.name} skill -> ${t.to}`);
  } catch (err) {
    console.warn(`zcode: could not install skills (${err.message}). Copy them from ${path.join(pkgRoot, 'skills')}.`);
  }
}

module.exports = { installSkills, targets };

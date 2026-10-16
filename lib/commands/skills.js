'use strict';
// zcode skills [status|install|uninstall] [claude|codex]
// Copies the orchestrator skills shipped in this package into Claude Code
// and Codex. Nothing runs at npm install time; this command is the installer.
const { installSkills, uninstallSkills, skillStatus, PLATFORMS } = require('../skills.js');

const ACTIONS = new Set(['status', 'install', 'uninstall']);

module.exports = function skills({ prompts, flags }) {
  const [action = 'status', ...platforms] = prompts;
  const fail = (msg) => {
    process.stderr.write(`zcode: ${msg}\nusage: zcode skills [status|install|uninstall] [claude|codex]\n`);
    process.exit(2);
  };
  if (!ACTIONS.has(action)) fail(`unknown skills action "${action}".`);
  for (const p of platforms) if (!PLATFORMS.includes(p)) fail(`unknown platform "${p}" (claude | codex).`);

  const view = (t) => ({ platform: t.platform, name: t.name, path: t.to, ...(t.installed !== undefined && { installed: t.installed }) });
  let rows;
  if (action === 'install') rows = installSkills({ platforms });
  else if (action === 'uninstall') rows = uninstallSkills({ platforms });
  else rows = skillStatus().filter((t) => !platforms.length || platforms.includes(t.platform));

  if (flags.json) {
    process.stdout.write(JSON.stringify({ action, skills: rows.map(view) }, null, 2) + '\n');
    return;
  }
  if (rows.length === 0) {
    process.stdout.write('zcode: nothing to uninstall\n');
    return;
  }
  for (const t of rows) {
    const what = action === 'install' ? 'installed' : action === 'uninstall' ? 'removed' : t.installed ? 'installed' : 'not installed';
    process.stdout.write(`${t.name.padEnd(12)} ${what.padEnd(14)} ${t.to}\n`);
  }
  if (action === 'status' && rows.some((t) => !t.installed)) {
    process.stdout.write('\nrun `zcode skills install` to install them\n');
  }
};

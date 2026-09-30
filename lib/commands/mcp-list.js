'use strict';
// lib/commands/mcp-list.js — print the effective MCP server set for this
// invocation as one JSON line and exit 0. Never spawns the engine; the
// value is exactly what a run with the same flags would register.
const { bootstrap } = require('../bootstrap.js');

module.exports = async function mcpList(parsed) {
  const flags = parsed.flags;
  const { overlay } = bootstrap({
    fresh: flags.fresh,
    mcpSpecs: flags.mcpSpecs,
    mcpInherit: flags.mcpInherit,
    skillsDirs: flags.skillsDirs,
    noSkills: flags.noSkills,
  });
  process.stdout.write(
    JSON.stringify({ type: 'mcp', servers: overlay.mcp.servers }) + '\n'
  );
  process.exit(0);
};

'use strict';
// lib/commands/mcp-list.js — print the effective MCP server set for this
// invocation as one JSON line and exit 0. Never spawns the engine and needs
// no key; the value is exactly what a run with the same flags registers.
const { effectiveMcpServers } = require('../isolation.js');

module.exports = async function mcpList(parsed) {
  const { flags } = parsed;
  const servers = effectiveMcpServers({ inherit: flags.mcpInherit, browser: !flags.noBrowser, mcpSpecs: flags.mcpSpecs });
  process.stdout.write(JSON.stringify({ type: 'mcp', servers }) + '\n');
  process.exit(0);
};

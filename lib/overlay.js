'use strict';
// Per-run overlays on the scratch HOME (DESIGN §6 extension): MCP servers
// and extra skills. Both are recomputed from read-only live sources plus the
// caller's flags on EVERY run, so the scratch never leaks a previous run's
// additions — the default state is always "what the desktop has".
const fs = require('node:fs');
const path = require('node:path');
const { LIVE_ZCODE } = require('./isolation.js');

// --- MCP ---------------------------------------------------------------------

// Base servers: the live desktop config, read-only, honoring `enabled`.
function liveMcpServers() {
  try {
    const cfg = JSON.parse(
      fs.readFileSync(path.join(LIVE_ZCODE, 'cli', 'config.json'), 'utf8')
    );
    const servers = cfg && cfg.mcp && cfg.mcp.servers;
    if (!servers || typeof servers !== 'object') return {};
    const out = {};
    for (const [name, def] of Object.entries(servers)) {
      if (!def || typeof def !== 'object') continue;
      if (def.enabled === false) continue;
      out[name] = def;
    }
    return out;
  } catch {
    return {};
  }
}

// Effective set for one run: live base (unless --no-mcp) merged with the
// parsed --mcp specs (specs win by name). Pure — no writes.
function effectiveMcpServers({ noMcp = false, mcpSpecs = [] } = {}) {
  const servers = noMcp ? {} : liveMcpServers();
  for (const spec of mcpSpecs) {
    for (const [name, def] of Object.entries(spec)) {
      servers[name] = def;
    }
  }
  return servers;
}

// Writes the effective set into the scratch cli config so the engine child
// picks it up at session start. Creates a minimal config when the scratch
// has none (fresh-machine synthesized path).
function applyMcpOverlay({ home, noMcp = false, mcpSpecs = [] }) {
  const servers = effectiveMcpServers({ noMcp, mcpSpecs });
  // Names the caller explicitly added — the CLI waits for these to settle
  // (connected or failed) before sending the prompt, so an explicit server
  // is never lost to a slow stdio spawn. Inherited servers are best-effort.
  const added = mcpSpecs.flatMap((spec) => Object.keys(spec));
  const configPath = path.join(home, '.zcode', 'cli', 'config.json');
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (!cfg || typeof cfg !== 'object') cfg = {};
  } catch {
    cfg = {};
  }
  cfg.mcp = { ...(cfg.mcp || {}), servers };
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(configPath, 0o600);
  return { servers, count: Object.keys(servers).length, added };
}

// --- skills ------------------------------------------------------------------

const MANIFEST = 'injected-skills.json';

function readManifest(rootDir) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(rootDir, MANIFEST), 'utf8'));
    return Array.isArray(m.skills) ? m : { skills: [] };
  } catch {
    return { skills: [] };
  }
}

// A --skills dir is either one skill (<dir>/SKILL.md) or a skills root
// (<dir>/<name>/SKILL.md). Returns [{name, dir}] of copyable skills.
function discoverSkillDirs(dir) {
  const found = [];
  if (fs.existsSync(path.join(dir, 'SKILL.md'))) {
    found.push({ name: path.basename(path.resolve(dir)), dir });
    return found;
  }
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (fs.existsSync(path.join(dir, entry.name, 'SKILL.md'))) {
      found.push({ name: entry.name, dir: path.join(dir, entry.name) });
    }
  }
  return found;
}

// Removes skills injected by a previous run, copies this run's extras in,
// records them in the manifest. --no-skills empties the scratch skills dir
// entirely (per-run hermetic mode).
function applySkillsOverlay({ rootDir, home, skillsDirs = [], noSkills = false }) {
  const scratchSkills = path.join(home, '.zcode', 'skills');
  const previous = readManifest(rootDir);
  for (const name of previous.skills) {
    fs.rmSync(path.join(scratchSkills, name), { recursive: true, force: true });
  }

  if (noSkills) {
    fs.rmSync(scratchSkills, { recursive: true, force: true });
    fs.mkdirSync(scratchSkills, { recursive: true });
    fs.writeFileSync(
      path.join(rootDir, MANIFEST),
      JSON.stringify({ skills: [] }, null, 2) + '\n',
      { mode: 0o600 }
    );
    return { injected: [] };
  }

  const injected = [];
  for (const dir of skillsDirs) {
    for (const { name, dir: skillDir } of discoverSkillDirs(dir)) {
      fs.rmSync(path.join(scratchSkills, name), { recursive: true, force: true });
      fs.cpSync(skillDir, path.join(scratchSkills, name), { recursive: true });
      injected.push(name);
    }
  }
  fs.writeFileSync(
    path.join(rootDir, MANIFEST),
    JSON.stringify({ skills: injected }, null, 2) + '\n',
    { mode: 0o600 }
  );
  return { injected };
}

module.exports = { effectiveMcpServers, applyMcpOverlay, applySkillsOverlay, discoverSkillDirs };

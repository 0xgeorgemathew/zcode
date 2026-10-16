'use strict';
// Scratch-HOME isolation (DESIGN §6, reworked in 0.4): the engine runs with
// HOME pointed at a directory we own so the live ~/.zcode — which the
// desktop app is actively using — is never written by us, and the user's
// OAuth credentials.json is never copied.
//
// 0.4: one engine HOME per zcode session (<root>/sessions/<id>/home) instead
// of one shared HOME. The shared HOME was rm -rf'd and rebuilt whenever a
// volatile desktop file (agents-state.json, bot-config.v3.json, …) changed
// mtime — which deleted the engine's session database under every other
// session and made --session resume 404 — and per-run MCP/skills overlays
// rewrote files that concurrent runs were reading. Per-session HOMEs give
// each session its own engine DB, config and skills; config files are
// refreshed in place on every invocation and engine state (cli/db,
// cli/agents, rollout, logs) is never deleted.
//
// Invariant (§6.4): zcode performs no writes to the live ~/.zcode, and
// credentials.json is never copied.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// The desktop app's live directory. ZAI_CODE_LIVE_DIR points elsewhere
// (e.g. a second desktop profile, or a fixture in tests).
function liveDir(env = process.env) {
  return env.ZAI_CODE_LIVE_DIR || path.join(os.homedir(), '.zcode');
}

const LIVE_ZCODE = liveDir({});
const LIVE_V2 = path.join(LIVE_ZCODE, 'v2');

// v2 top-level entries we deliberately never copy.
const V2_EXCLUDE_FILES = new Set(['credentials.json', '.DS_Store']);
function isV2Excluded(name) {
  return V2_EXCLUDE_FILES.has(name) || name.startsWith('tasks-index.sqlite');
}

// Root of zcode's own state. MUST NOT be ~/.zcode: that is the desktop
// app's live directory (0.3.0/0.3.1 regression — the package rename made
// rootDir collide with it). Ours is ~/.zcode-cli.
function rootDir(env = process.env) {
  return env.ZAI_CODE_HOME || path.join(os.homedir(), '.zcode-cli');
}

// --- small fs helpers ---------------------------------------------------------

function writeJson600(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function listDir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

// --- provider/key rewriting -----------------------------------------------------

// Prune to exactly the zai-api rule and swap in the package key (§6.2 item 2).
function rewriteProviderConfig(target, key) {
  const parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
  const rules =
    parsed.config &&
    parsed.config.providerConfigRules &&
    parsed.config.providerConfigRules.providerRules;
  if (!Array.isArray(rules)) {
    throw new Error(`unexpected provider_config.json shape at ${target}`);
  }
  const zaiRules = rules.filter((r) => r && r.providerId === 'zai-api');
  if (zaiRules.length === 0) {
    throw new Error(`no zai-api rule found in provider_config.json at ${target}`);
  }
  const rule = zaiRules[0];
  rule.config = rule.config || {};
  rule.config.group = rule.config.group || 'standard-personal';
  rule.config.access = { type: 'api-key', apiKey: key };
  parsed.config.providerConfigRules.providerRules = [rule];
  writeJson600(target, parsed);
}

function synthesizedProviderConfig(key) {
  return {
    schemaVersion: 1,
    config: {
      providerConfigRules: {
        providerRules: [
          {
            providerId: 'zai-api',
            templateId: 'zai-api',
            config: {
              group: 'standard-personal',
              access: { type: 'api-key', apiKey: key },
            },
          },
        ],
      },
    },
  };
}

// --- skills -------------------------------------------------------------------

// A --skills dir is either one skill (<dir>/SKILL.md) or a skills root
// (<dir>/<name>/SKILL.md). Returns [{name, dir}] of copyable skills.
function discoverSkillDirs(dir) {
  if (fs.existsSync(path.join(dir, 'SKILL.md'))) {
    return [{ name: path.basename(path.resolve(dir)), dir }];
  }
  return listDir(dir)
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(dir, e.name, 'SKILL.md')))
    .map((e) => ({ name: e.name, dir: path.join(dir, e.name) }));
}

// --- MCP ----------------------------------------------------------------------

// The live desktop MCP servers, read-only, honoring `enabled`.
function liveMcpServers(live = LIVE_ZCODE) {
  const cfg = readJson(path.join(live, 'cli', 'config.json'));
  const servers = cfg && cfg.mcp && cfg.mcp.servers;
  if (!servers || typeof servers !== 'object') return {};
  const out = {};
  for (const [name, def] of Object.entries(servers)) {
    if (!def || typeof def !== 'object' || def.enabled === false) continue;
    out[name] = def;
  }
  return out;
}

// Effective set for one invocation. Hermetic by default: ONLY the caller's
// --mcp servers. --mcp-inherit pulls in the desktop's enabled servers as a
// base (specs still win by name). Hermetic default is deliberate: the
// desktop set includes OAuth servers that can never complete headless and
// stall the engine's connect pool.
function effectiveMcpServers({ inherit = false, mcpSpecs = [], live = LIVE_ZCODE } = {}) {
  const servers = inherit ? liveMcpServers(live) : {};
  for (const spec of mcpSpecs) {
    for (const [name, def] of Object.entries(spec)) servers[name] = def;
  }
  return servers;
}

// --- shared caches ------------------------------------------------------------

// Engine-populated caches that are expensive to recreate per session (the
// plugin marketplace cache is ~30 MB) are shared through symlinks into
// <root>/shared. A pre-0.4 shared HOME donates its caches once.
const SHARED_CACHES = [
  { name: 'plugins', rel: path.join('.zcode', 'cli', 'plugins') },
  { name: 'runtime', rel: path.join('.zcode', 'v2', 'runtime') },
];

function linkSharedCaches(home, root) {
  for (const cache of SHARED_CACHES) {
    const shared = path.join(root, 'shared', cache.name);
    if (!fs.existsSync(shared)) {
      const legacy = path.join(root, 'home', cache.rel);
      fs.mkdirSync(path.dirname(shared), { recursive: true, mode: 0o700 });
      try {
        if (fs.existsSync(legacy) && !fs.lstatSync(legacy).isSymbolicLink()) {
          fs.renameSync(legacy, shared);
        }
      } catch {
        /* fall through to an empty cache */
      }
      fs.mkdirSync(shared, { recursive: true, mode: 0o700 });
    }
    const target = path.join(home, cache.rel);
    if (fs.existsSync(target) || isDanglingLink(target)) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    try {
      fs.symlinkSync(shared, target, 'dir');
    } catch {
      /* engine recreates the cache itself */
    }
  }
}

function isDanglingLink(p) {
  try {
    return fs.lstatSync(p).isSymbolicLink() && !fs.existsSync(p);
  } catch {
    return false;
  }
}

// --- build ------------------------------------------------------------------

// Creates or refreshes one engine HOME. Config is (re)written from the live
// sources + this invocation's flags; engine state under the HOME (cli/db,
// cli/agents, cli/rollout, logs, memories) is never touched, so a session
// stays resumable across invocations. Returns facts for reporting.
function buildEngineHome({
  home,
  root,
  key,
  live = LIVE_ZCODE,
  mcpSpecs = [],
  mcpInherit = false,
  skillsDirs = [],
  noSkills = false,
}) {
  const zdir = path.join(home, '.zcode');
  const v2 = path.join(zdir, 'v2');
  const cliDir = path.join(zdir, 'cli');
  fs.mkdirSync(v2, { recursive: true, mode: 0o700 });
  fs.mkdirSync(cliDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(home, 0o700);

  // v2: top-level files only, no credentials.json, no sqlite (§6.2 item 1).
  const liveV2 = path.join(live, 'v2');
  const v2Files = listDir(liveV2).filter((e) => e.isFile() && !isV2Excluded(e.name));
  for (const entry of v2Files) {
    fs.copyFileSync(path.join(liveV2, entry.name), path.join(v2, entry.name));
  }
  const providerConfig = path.join(v2, 'provider_config.json');
  const mode = v2Files.some((e) => e.name === 'provider_config.json')
    ? 'copied-v2-top-level'
    : 'synthesized';
  if (mode === 'synthesized') writeJson600(providerConfig, synthesizedProviderConfig(key));
  else rewriteProviderConfig(providerConfig, key);

  // cli/config.json: live copy (builtin:zai key swapped) + this run's MCP set.
  const cfg = readJson(path.join(live, 'cli', 'config.json')) || {};
  const zai = cfg.provider && cfg.provider['builtin:zai'];
  if (zai) {
    zai.options = zai.options || {};
    zai.options.apiKey = key;
  }
  const servers = effectiveMcpServers({ inherit: mcpInherit, mcpSpecs, live });
  cfg.mcp = { ...(cfg.mcp || {}), servers };
  writeJson600(path.join(cliDir, 'config.json'), cfg);

  // Agent profiles + AGENTS.md: mirror the live set exactly.
  const agentsDir = path.join(zdir, 'agents');
  fs.rmSync(agentsDir, { recursive: true, force: true });
  for (const entry of listDir(path.join(live, 'agents'))) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.copyFileSync(path.join(live, 'agents', entry.name), path.join(agentsDir, entry.name));
  }
  const agentsMd = path.join(zdir, 'AGENTS.md');
  if (fs.existsSync(path.join(live, 'AGENTS.md'))) {
    fs.copyFileSync(path.join(live, 'AGENTS.md'), agentsMd);
  } else {
    fs.rmSync(agentsMd, { force: true });
  }

  // Skills: live user skills (unless --no-skills) + this run's --skills.
  // Project skills (<cwd>/.zcode/skills) need no copy — the engine reads
  // them from the real workspace.
  const skillsDir = path.join(zdir, 'skills');
  fs.rmSync(skillsDir, { recursive: true, force: true });
  fs.mkdirSync(skillsDir, { recursive: true });
  let skillsCopied = 0;
  if (!noSkills) {
    const liveSkills = path.join(live, 'skills');
    for (const entry of listDir(liveSkills)) {
      if (!entry.isDirectory()) continue;
      if (!fs.existsSync(path.join(liveSkills, entry.name, 'SKILL.md'))) continue;
      fs.cpSync(path.join(liveSkills, entry.name), path.join(skillsDir, entry.name), {
        recursive: true,
      });
      skillsCopied++;
    }
  }
  const skillsInjected = [];
  if (!noSkills) {
    for (const dir of skillsDirs) {
      for (const { name, dir: skillDir } of discoverSkillDirs(dir)) {
        fs.rmSync(path.join(skillsDir, name), { recursive: true, force: true });
        fs.cpSync(skillDir, path.join(skillsDir, name), { recursive: true });
        skillsInjected.push(name);
      }
    }
  }

  if (root) linkSharedCaches(home, root);

  return {
    home,
    mode,
    copiedFiles: v2Files.length,
    skillsCopied,
    skillsInjected,
    mcp: {
      servers,
      // Names the caller explicitly added — the CLI waits for these to
      // settle before sending the prompt. Inherited servers are best-effort.
      added: mcpSpecs.flatMap((spec) => Object.keys(spec)),
    },
  };
}

// --- migration ----------------------------------------------------------------

// The only names pre-0.4 versions created at a root. migrateRoot moves
// exactly these out of legacy locations and never touches anything else.
const OUR_ARTIFACTS = ['credentials.json', 'build-stamp.json', 'injected-skills.json', 'home'];

// 0.3.2 migration: vacate our artifacts from (a) the live ~/.zcode, where
// 0.3.0/0.3.1 wrongly wrote them, and (b) the pre-rename ~/.zai-code root,
// into the ~/.zcode-cli root. Idempotent; never writes or deletes anything
// else in the live directory.
function migrateRoot(env = process.env) {
  const root = rootDir(env);
  try {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  } catch {
    return; // unwritable home — callers surface it
  }
  const sources = [liveDir(env), path.join(os.homedir(), '.zai-code')];
  for (const dir of sources) {
    let entries;
    try {
      entries = new Set(fs.readdirSync(dir));
    } catch {
      continue;
    }
    for (const name of OUR_ARTIFACTS) {
      if (!entries.has(name)) continue;
      const src = path.join(dir, name);
      const dest = path.join(root, name);
      try {
        if (fs.existsSync(dest)) fs.rmSync(src, { recursive: true, force: true });
        else fs.renameSync(src, dest);
      } catch {
        /* keep going; a missing artifact just rebuilds */
      }
    }
  }
}

// Env for the engine child process (§6.3): HOME=scratch, pinned builtin
// config, and the uncontrolled overrides deleted. cwd is set by the caller.
function engineEnv({ home, builtinProviderConfig, parentEnv = process.env }) {
  const childEnv = { ...parentEnv };
  const realHome = parentEnv.HOME || os.homedir();
  // The scratch HOME hides the user's tool caches. Point Playwright and npm
  // back at the real ones so installed browsers and packages are found.
  if (!childEnv.PLAYWRIGHT_BROWSERS_PATH) {
    const cache = process.platform === 'darwin'
      ? path.join(realHome, 'Library', 'Caches', 'ms-playwright')
      : path.join(realHome, '.cache', 'ms-playwright');
    if (fs.existsSync(cache)) childEnv.PLAYWRIGHT_BROWSERS_PATH = cache;
  }
  if (!childEnv.npm_config_cache && !childEnv.NPM_CONFIG_CACHE) {
    childEnv.npm_config_cache = path.join(realHome, '.npm');
  }
  childEnv.HOME = home;
  childEnv.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = builtinProviderConfig;
  for (const name of [
    'ZCODE_STORAGE_DIR',
    'ZCODE_DATA_BASE_DIR',
    'ZCODE_PERSONAL_PROVIDER_CONFIG_FILE',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_BASE_URL',
  ]) {
    delete childEnv[name];
  }
  return childEnv;
}

module.exports = {
  buildEngineHome,
  engineEnv,
  rootDir,
  liveDir,
  migrateRoot,
  effectiveMcpServers,
  liveMcpServers,
  discoverSkillDirs,
  LIVE_ZCODE,
  LIVE_V2,
};

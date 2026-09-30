'use strict';
// Scratch-HOME isolation (DESIGN §6): the engine runs with HOME pointed at a
// copy we own (~/.zcode/home, mode 700) so the live ~/.zcode — which the
// desktop app is actively using — is never written by us, and the user's
// OAuth credentials.json is never copied.
//
// Invariant (§6.4): zcode performs no writes to the live ~/.zcode. The
// fallback ladder NEVER re-adds credentials.json.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const LIVE_ZCODE = path.join(os.homedir(), '.zcode');
const LIVE_V2 = path.join(LIVE_ZCODE, 'v2');

// v2 top-level entries we deliberately never copy.
const V2_EXCLUDE_FILES = new Set(['credentials.json', '.DS_Store']);
function isV2Excluded(name) {
  return (
    V2_EXCLUDE_FILES.has(name) || name.startsWith('tasks-index.sqlite')
  );
}

const keySha256 = (key) =>
  crypto.createHash('sha256').update(key).digest('hex');

// --- source inventory -------------------------------------------------------

// Files the scratch copy depends on: every source path + mtimeMs. A change
// in the set, an mtime, or the key fingerprint invalidates the stamp.
function sourceInventory() {
  const sources = [];
  const pushFile = (abs) => {
    try {
      sources.push({ file: abs, mtimeMs: fs.statSync(abs).mtimeMs });
    } catch {
      /* source vanished — not copied */
    }
  };
  try {
    for (const entry of fs.readdirSync(LIVE_V2, { withFileTypes: true })) {
      if (!entry.isFile() || isV2Excluded(entry.name)) continue;
      pushFile(path.join(LIVE_V2, entry.name));
    }
  } catch {
    /* no live v2 — synthesized path */
  }
  pushFile(path.join(LIVE_ZCODE, 'cli', 'config.json'));
  pushFile(path.join(LIVE_ZCODE, 'AGENTS.md'));
  try {
    for (const entry of fs.readdirSync(path.join(LIVE_ZCODE, 'skills'), {
      withFileTypes: true,
    })) {
      if (entry.isDirectory()) {
        pushFile(path.join(LIVE_ZCODE, 'skills', entry.name, 'SKILL.md'));
      }
    }
  } catch {
    /* no skills dir */
  }
  try {
    for (const entry of fs.readdirSync(path.join(LIVE_ZCODE, 'agents'), {
      withFileTypes: true,
    })) {
      if (entry.isFile() && entry.name.endsWith('.md')) {
        pushFile(path.join(LIVE_ZCODE, 'agents', entry.name));
      }
    }
  } catch {
    /* no agents dir */
  }
  return sources;
}

// --- build ------------------------------------------------------------------

function writeJson600(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', {
    mode: 0o600,
  });
  fs.chmodSync(file, 0o600);
}

function copyFileTo(src, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, path.basename(src));
  fs.copyFileSync(src, dest);
  return dest;
}

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
    throw new Error(
      `no zai-api rule found in provider_config.json at ${target}`
    );
  }
  const rule = zaiRules[0];
  rule.config = rule.config || {};
  rule.config.group = rule.config.group || 'standard-personal';
  rule.config.access = {
    type: 'api-key',
    apiKey: key,
  };
  parsed.config.providerConfigRules.providerRules = [rule];
  writeJson600(target, parsed);
}

// Overwrite builtin:zai apiKey with the package key (§6.2 item 3).
function rewriteCliConfig(target, key) {
  const parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
  const zai = parsed.provider && parsed.provider['builtin:zai'];
  if (zai) {
    zai.options = zai.options || {};
    zai.options.apiKey = key;
  }
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

// Tier (a), the review-proven recipe: top-level v2 files, no directories, no
// credentials.json, no sqlite. Fresh machines (no live v2) synthesize instead.
function buildScratch(home, key) {
  fs.rmSync(home, { recursive: true, force: true });
  const scratchV2 = path.join(home, '.zcode', 'v2');
  fs.mkdirSync(scratchV2, { recursive: true });

  let mode = 'synthesized';
  let copied = 0;
  try {
    const entries = fs.readdirSync(LIVE_V2, { withFileTypes: true });
    const files = entries.filter(
      (e) => e.isFile() && !isV2Excluded(e.name)
    );
    if (files.length > 0 || fs.existsSync(path.join(LIVE_V2, 'provider_config.json'))) {
      mode = 'copied-v2-top-level';
    }
    for (const entry of files) {
      const dest = copyFileTo(path.join(LIVE_V2, entry.name), scratchV2);
      if (entry.name === 'provider_config.json') {
        rewriteProviderConfig(dest, key);
      }
      copied++;
    }
  } catch {
    /* no live v2 at all */
  }

  const scratchProviderConfig = path.join(scratchV2, 'provider_config.json');
  if (!fs.existsSync(scratchProviderConfig)) {
    writeJson600(scratchProviderConfig, synthesizedProviderConfig(key));
  } else {
    // Ensure key swap even when the copy step found an unexpected shape.
    rewriteProviderConfig(scratchProviderConfig, key);
  }

  const liveCliConfig = path.join(LIVE_ZCODE, 'cli', 'config.json');
  if (fs.existsSync(liveCliConfig)) {
    const dest = copyFileTo(liveCliConfig, path.join(home, '.zcode', 'cli'));
    rewriteCliConfig(dest, key);
  }

  const liveAgents = path.join(LIVE_ZCODE, 'agents');
  if (fs.existsSync(liveAgents)) {
    for (const entry of fs.readdirSync(liveAgents, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.md')) {
        copyFileTo(path.join(liveAgents, entry.name), path.join(home, '.zcode', 'agents'));
      }
    }
  }
  const liveAgentsMd = path.join(LIVE_ZCODE, 'AGENTS.md');
  if (fs.existsSync(liveAgentsMd)) {
    copyFileTo(liveAgentsMd, path.join(home, '.zcode'));
  }

  // Skills: copy each <name>/SKILL.md dir from the live user scope so the
  // engine (running under this scratch HOME) sees the same skills as the
  // desktop. Project skills (<cwd>/.zcode/skills) need no copy — the engine
  // reads them from the real workspace.
  let skillsCopied = 0;
  const liveSkills = path.join(LIVE_ZCODE, 'skills');
  if (fs.existsSync(liveSkills)) {
    for (const entry of fs.readdirSync(liveSkills, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (!fs.existsSync(path.join(liveSkills, entry.name, 'SKILL.md'))) continue;
      fs.cpSync(
        path.join(liveSkills, entry.name),
        path.join(home, '.zcode', 'skills', entry.name),
        { recursive: true }
      );
      skillsCopied++;
    }
  }

  return { mode, copied, skillsCopied };
}

// --- public API -------------------------------------------------------------

function rootDir(env = process.env) {
  return env.ZAI_CODE_HOME || path.join(os.homedir(), '.zcode');
}

// Ensures the scratch HOME exists and is current. Returns
// {root, home, mode, built, stamp}.
function ensureIsolation(key, { fresh = false, env = process.env } = {}) {
  const root = rootDir(env);
  fs.mkdirSync(root, { recursive: true });
  fs.chmodSync(root, 0o700);
  const home = path.join(root, 'home');
  const stampFile = path.join(root, 'build-stamp.json');

  const sources = sourceInventory();
  const fingerprint = keySha256(key);
  const desired = {
    version: 1,
    keySha256: fingerprint,
    sources,
  };

  if (!fresh && fs.existsSync(home) && fs.existsSync(stampFile)) {
    try {
      const stamp = JSON.parse(fs.readFileSync(stampFile, 'utf8'));
      const sameSources =
        Array.isArray(stamp.sources) &&
        stamp.sources.length === desired.sources.length &&
        stamp.sources.every(
          (s, i) =>
            s.file === desired.sources[i].file && s.mtimeMs === desired.sources[i].mtimeMs
        );
      if (stamp.keySha256 === fingerprint && sameSources) {
        return {
          root,
          home,
          mode: stamp.mode,
          built: false,
          stamp,
        };
      }
    } catch {
      /* corrupt stamp — rebuild */
    }
  }

  const { mode, copied, skillsCopied } = buildScratch(home, key);
  fs.chmodSync(home, 0o700);
  const stamp = {
    ...desired,
    mode,
    copiedFiles: copied,
    skillsCopied,
    builtAt: new Date().toISOString(),
  };
  writeJson600(stampFile, stamp);
  return { root, home, mode, built: true, stamp };
}

// Env for the engine child process (§6.3): HOME=scratch, pinned builtin
// config, and the uncontrolled overrides deleted. cwd is untouched here —
// the caller sets it to the user's real workspace.
function engineEnv({ home, builtinProviderConfig, parentEnv = process.env }) {
  const childEnv = { ...parentEnv };
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
  ensureIsolation,
  engineEnv,
  rootDir,
  keySha256,
  LIVE_ZCODE,
  LIVE_V2,
};

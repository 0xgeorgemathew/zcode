'use strict';
// Engine resolution + builtin provider config (DESIGN §4).
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const APP_BUNDLE_ENGINE =
  '/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs';

class EngineNotFoundError extends Error {
  constructor(probed) {
    super(
      `ZCode engine not found. Probed:\n  ${probed.join('\n  ')}\n` +
        'Set ZAI_CODE_ENGINE to the zcode.cjs bundle path.'
    );
    this.code = 'ZAI_NO_ENGINE';
    this.probed = probed;
  }
}

class BuiltinConfigNotFoundError extends Error {
  constructor(probed) {
    super(
      `ZCode builtin provider config not found. Probed:\n  ${probed.join('\n  ')}\n` +
        'Set ZAI_CODE_BUILTIN_PROVIDER_CONFIG to the zcode-builtin.json path.'
    );
    this.code = 'ZAI_NO_BUILTIN_CONFIG';
    this.probed = probed;
  }
}

// Our own wrapper's real path. The engine resolver must never resolve to
// itself: `npm install -g` puts a `zcode` symlink on PATH, and before the
// 0.3.1 fix the PATH probe grabbed it as "the engine" (0.3.0 regression:
// every command then exited 4 probing <prefix>/config/provider/…).
const SELF_BIN_PATH = (() => {
  try {
    return fs.realpathSync(path.join(__dirname, '..', 'bin', 'zcode.js'));
  } catch {
    return null;
  }
})();

function isSelf(candidate) {
  if (!SELF_BIN_PATH) return false;
  try {
    return fs.realpathSync(candidate) === SELF_BIN_PATH;
  } catch {
    return false;
  }
}

// Resolves a candidate that is either the zcode.cjs file itself or a
// directory containing it. strictFile (default true for everything except
// an explicit ZAI_CODE_ENGINE): a bare file is only accepted when it is
// literally named zcode.cjs — the engine bundle — so wrappers and launchers
// named `zcode` never pass. Our own binary is always rejected.
function resolveCandidate(candidate, { strictFile = true } = {}) {
  if (isSelf(candidate)) return null;
  let st;
  try {
    st = fs.statSync(candidate);
  } catch {
    return null;
  }
  if (st.isFile()) {
    if (strictFile && path.basename(candidate) !== 'zcode.cjs') return null;
    return path.resolve(candidate);
  }
  if (st.isDirectory()) {
    const inner = path.join(candidate, 'zcode.cjs');
    try {
      if (fs.statSync(inner).isFile() && !isSelf(inner)) {
        return path.resolve(inner);
      }
    } catch {
      /* not there */
    }
  }
  return null;
}

function whichOnPath(bin, envPath) {
  if (!envPath) return null;
  for (const dir of envPath.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, bin);
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      /* keep scanning */
    }
  }
  return null;
}

// First hit wins (DESIGN §4, revised 0.3.1): explicit env override, then
// the app bundle (the canonical macOS location), then PATH/home probes —
// which now only accept a real zcode.cjs, never a same-named wrapper.
// Throws EngineNotFoundError listing all probes.
function resolveEngine(env = process.env) {
  const probed = [];
  const candidates = [];
  if (env.ZAI_CODE_ENGINE) candidates.push({ path: env.ZAI_CODE_ENGINE, strictFile: false });
  candidates.push({ path: APP_BUNDLE_ENGINE });
  const onPath = whichOnPath('zcode', env.PATH);
  if (onPath) candidates.push({ path: onPath });
  candidates.push({ path: path.join(os.homedir(), '.local', 'bin', 'zcode') });
  candidates.push({ path: path.join(os.homedir(), '.zcode', 'runtime', 'zcode.cjs') });
  for (const candidate of candidates) {
    const resolved = resolveCandidate(candidate.path, {
      strictFile: candidate.strictFile ?? true,
    });
    if (resolved) return resolved;
    probed.push(candidate.path);
  }
  throw new EngineNotFoundError(probed);
}

// Engine-adjacent builtin provider config, or env override. Throws
// BuiltinConfigNotFoundError with the probed paths.
function resolveBuiltinProviderConfig(enginePath, env = process.env) {
  const probed = [];
  const candidates = [];
  if (env.ZAI_CODE_BUILTIN_PROVIDER_CONFIG) {
    candidates.push(env.ZAI_CODE_BUILTIN_PROVIDER_CONFIG);
  }
  candidates.push(
    path.resolve(
      path.dirname(enginePath),
      '..',
      'config',
      'provider',
      'zcode-builtin.json'
    )
  );
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) return path.resolve(candidate);
    } catch {
      /* fall through */
    }
    probed.push(candidate);
  }
  throw new BuiltinConfigNotFoundError(probed);
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

// `zcode.cjs version` run under the ISOLATED env (never the live HOME).
// Returns trimmed stdout or null.
function engineVersion(nodeBin, enginePath, childEnv) {
  const res = spawnSync(nodeBin, [enginePath, 'version'], {
    env: childEnv,
    encoding: 'utf8',
    timeout: 20000,
  });
  if (res.error || res.status !== 0) return null;
  return (res.stdout || '').trim() || null;
}

module.exports = {
  resolveEngine,
  resolveBuiltinProviderConfig,
  sha256File,
  engineVersion,
  EngineNotFoundError,
  BuiltinConfigNotFoundError,
  APP_BUNDLE_ENGINE,
};

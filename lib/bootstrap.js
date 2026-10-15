'use strict';
// Resolves everything an engine spawn needs — key, engine bundle, builtin
// provider config, node binary — and builds engine clients. Throws
// ConfigError carrying the documented exit code (3 no key, 4 no engine /
// builtin config) instead of exiting, so callers decide how to report.
const { resolveKey, NoKeyError } = require('./key.js');
const {
  resolveEngine,
  resolveBuiltinProviderConfig,
  EngineNotFoundError,
  BuiltinConfigNotFoundError,
} = require('./engine.js');
const { engineEnv } = require('./isolation.js');
const { AppServerClient } = require('./appserver.js');

class ConfigError extends Error {
  constructor(message, exitCode) {
    super(message);
    this.exitCode = exitCode;
  }
}

// Replaces the API key with *** in any text that is about to be printed or
// stored (defense in depth — the engine never echoes the key, but error
// paths dump raw frames).
function makeScrub(key) {
  return (text) => (key ? String(text).split(key).join('***') : String(text));
}

function resolveRuntime(env = process.env) {
  let key;
  try {
    key = resolveKey(env);
  } catch (err) {
    if (err instanceof NoKeyError) throw new ConfigError(err.message, 3);
    throw err;
  }
  let enginePath;
  let builtinConfig;
  try {
    enginePath = resolveEngine(env);
    builtinConfig = resolveBuiltinProviderConfig(enginePath, env);
  } catch (err) {
    if (err instanceof EngineNotFoundError || err instanceof BuiltinConfigNotFoundError) {
      throw new ConfigError(err.message, 4);
    }
    throw err;
  }
  return {
    key,
    scrub: makeScrub(key),
    enginePath,
    builtinConfig,
    nodeBin: env.ZAI_CODE_NODE || process.execPath,
  };
}

function makeClient(runtime, { home, cwd }) {
  return new AppServerClient({
    nodeBin: runtime.nodeBin,
    enginePath: runtime.enginePath,
    env: engineEnv({ home, builtinProviderConfig: runtime.builtinConfig }),
    cwd,
    scrub: runtime.scrub,
  });
}

module.exports = { resolveRuntime, makeClient, makeScrub, ConfigError };

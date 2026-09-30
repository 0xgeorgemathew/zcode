'use strict';
// Shared bootstrap for turn commands (run/agent): resolves key, engine,
// builtin config and the scratch HOME, then builds an AppServerClient.
// Exits with the documented codes (3 no key, 4 no engine/builtin config).
const { resolveKey, NoKeyError } = require('./key.js');
const {
  resolveEngine,
  resolveBuiltinProviderConfig,
  EngineNotFoundError,
  BuiltinConfigNotFoundError,
} = require('./engine.js');
const { ensureIsolation, engineEnv } = require('./isolation.js');
const { AppServerClient } = require('./appserver.js');

// Returns a function that replaces the API key with *** in any text that is
// about to be printed or dumped (defense in depth — the engine never echoes
// the key, but exit-5 dumps raw frames).
function makeScrub(key) {
  return (text) => String(text).split(key).join('***');
}

function bootstrap({ fresh = false } = {}) {
  let key;
  try {
    key = resolveKey(process.env);
  } catch (err) {
    if (err instanceof NoKeyError) {
      process.stderr.write(`zai-code: ${err.message}\n`);
      process.exit(3);
    }
    throw err;
  }
  const scrub = makeScrub(key);

  let enginePath;
  try {
    enginePath = resolveEngine(process.env);
  } catch (err) {
    if (err instanceof EngineNotFoundError) {
      process.stderr.write(`zai-code: ${err.message}\n`);
      process.exit(4);
    }
    throw err;
  }
  let builtinConfig;
  try {
    builtinConfig = resolveBuiltinProviderConfig(enginePath, process.env);
  } catch (err) {
    if (err instanceof BuiltinConfigNotFoundError) {
      process.stderr.write(`zai-code: ${err.message}\n`);
      process.exit(4);
    }
    throw err;
  }

  const isolation = ensureIsolation(key, { fresh, env: process.env });
  const nodeBin = process.env.ZAI_CODE_NODE || process.execPath;
  const childEnv = engineEnv({
    home: isolation.home,
    builtinProviderConfig: builtinConfig,
  });
  const client = new AppServerClient({
    nodeBin,
    enginePath,
    env: childEnv,
    cwd: process.cwd(),
    scrub,
  });
  return { key, scrub, enginePath, builtinConfig, isolation, nodeBin, childEnv, client };
}

module.exports = { bootstrap, makeScrub };

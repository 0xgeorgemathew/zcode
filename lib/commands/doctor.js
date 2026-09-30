'use strict';
// lib/commands/doctor.js — engine + isolation + key report (DESIGN §10).
// Never prints the key. Warns when the spawning node major < 26 (R11).
const {
  resolveEngine,
  resolveBuiltinProviderConfig,
  sha256File,
  engineVersion,
  EngineNotFoundError,
  BuiltinConfigNotFoundError,
} = require('../engine.js');
const { resolveKey, NoKeyError, rootDir } = require('../key.js');
const { ensureIsolation, engineEnv } = require('../isolation.js');
const { effectiveMcpServers } = require('../overlay.js');

module.exports = async function doctor(parsed) {
  const flags = parsed.flags;
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

  const isolation = ensureIsolation(key, { fresh: flags.fresh, env: process.env });
  const nodeBin = process.env.ZAI_CODE_NODE || process.execPath;
  const childEnv = engineEnv({
    home: isolation.home,
    builtinProviderConfig: builtinConfig,
  });
  const version = engineVersion(nodeBin, enginePath, childEnv);
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  const nodeWarning = nodeMajor < 26;

  const report = {
    ok: true,
    node: {
      version: process.versions.node,
      major: nodeMajor,
      engineBin: nodeBin,
      recommendation:
        nodeMajor < 26
          ? 'engine has only been tested under node >= 26; set ZAI_CODE_NODE to a newer interpreter'
          : 'ok',
      warning: nodeWarning,
    },
    engine: {
      path: enginePath,
      sha256: sha256File(enginePath),
      version,
      builtinProviderConfig: builtinConfig,
    },
    isolation: {
      root: isolation.root,
      home: isolation.home,
      mode: isolation.mode,
      builtNow: isolation.built,
      skillsCopied:
        (isolation.stamp && typeof isolation.stamp.skillsCopied === 'number'
          ? isolation.stamp.skillsCopied
          : 0) || 0,
      mcpServersInherited: Object.keys(effectiveMcpServers({})).length,
      experimental:
        isolation.mode === 'synthesized'
          ? 'synthesized config path is unproven; copy a real ~/.zcode/v2 or verify once on a clean HOME'
          : null,
    },
    key: { configured: true },
  };

  if (flags.json) {
    process.stdout.write(JSON.stringify(report) + '\n');
  } else {
    process.stdout.write(
      [
        `zai-code doctor`,
        `  node ${report.node.version} (${nodeBin})${nodeWarning ? '  ⚠ ' + report.node.recommendation : ''}`,
        `  engine ${enginePath}`,
        `    sha256 ${report.engine.sha256}`,
        `    version ${version ?? 'unknown'}`,
        `  builtin provider config ${builtinConfig}`,
        `  isolation home ${isolation.home} (mode: ${isolation.mode}${isolation.built ? ', built now' : ', cached'})`,
        `  skills inherited ${report.isolation.skillsCopied}, mcp servers inherited ${report.isolation.mcpServersInherited}`,
        `  api key configured (never printed)`,
        report.isolation.experimental ? `  ⚠ ${report.isolation.experimental}` : '',
      ]
        .filter(Boolean)
        .join('\n') + '\n'
    );
  }
  process.exit(0);
};

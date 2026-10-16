'use strict';
// lib/commands/doctor.js — engine + isolation + key report. Builds a probe
// engine HOME (<root>/doctor/home) exactly the way a session does, so what
// doctor reports is what a session gets. Never prints the key. Warns when
// the spawning node major < 26 (R11).
const path = require('node:path');
const { sha256File, engineVersion } = require('../engine.js');
const { resolveRuntime, ConfigError } = require('../bootstrap.js');
const { buildEngineHome, engineEnv, rootDir, liveDir, effectiveMcpServers } = require('../isolation.js');
const store = require('../store.js');
const { modelLevels, modelVision } = require('../models.js');

module.exports = async function doctor(parsed) {
  const flags = parsed.flags;
  let runtime;
  try {
    runtime = resolveRuntime(process.env);
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`zcode: ${err.message}\n`);
      process.exit(err.exitCode);
    }
    throw err;
  }
  const { enginePath, builtinConfig, nodeBin } = runtime;
  const root = rootDir(process.env);
  const built = buildEngineHome({
    home: path.join(root, 'doctor', 'home'),
    root,
    key: runtime.key,
    live: liveDir(process.env),
  });
  const version = engineVersion(nodeBin, enginePath, engineEnv({ home: built.home, builtinProviderConfig: builtinConfig }));
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  const nodeWarning = nodeMajor < 26;
  const sessions = store.listSessions(process.env);

  const report = {
    ok: true,
    node: {
      version: process.versions.node,
      major: nodeMajor,
      engineBin: nodeBin,
      recommendation: nodeWarning
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
    models: modelLevels({ builtinConfig }),
    vision: modelVision({ builtinConfig }),
    isolation: {
      root,
      home: built.home,
      sessionsDir: store.sessionsDir(process.env),
      mode: built.mode,
      builtNow: true,
      skillsCopied: built.skillsCopied,
      mcpServersInherited: Object.keys(effectiveMcpServers({ inherit: true, live: liveDir(process.env) })).length,
      experimental:
        built.mode === 'synthesized'
          ? 'synthesized config path is unproven; copy a real ~/.zcode/v2 or verify once on a clean HOME'
          : null,
    },
    sessions: {
      total: sessions.length,
      running: sessions.filter((s) => s.live).length,
      interrupted: sessions.filter((s) => s.state === 'interrupted').length,
    },
    key: { configured: true },
  };

  if (flags.json) {
    process.stdout.write(JSON.stringify(report) + '\n');
  } else {
    process.stdout.write(
      [
        'zcode doctor',
        `  node ${report.node.version} (${nodeBin})${nodeWarning ? '  ⚠ ' + report.node.recommendation : ''}`,
        `  engine ${enginePath}`,
        `    sha256 ${report.engine.sha256}`,
        `    version ${version ?? 'unknown'}`,
        `  builtin provider config ${builtinConfig}`,
        `  models ${Object.entries(report.models).map(([id, l]) => `${id} (effort ${l.join('|')}, ${report.vision[id] ? 'images' : 'no images'})`).join(', ')}`,
        `  isolation root ${root} (one engine HOME per session; config mode: ${built.mode})`,
        `  skills inherited ${built.skillsCopied}, mcp servers available with --mcp-inherit ${report.isolation.mcpServersInherited}`,
        `  sessions ${report.sessions.total} (${report.sessions.running} running, ${report.sessions.interrupted} interrupted)`,
        '  api key configured (never printed)',
        report.isolation.experimental ? `  ⚠ ${report.isolation.experimental}` : '',
      ]
        .filter(Boolean)
        .join('\n') + '\n'
    );
  }
  process.exit(0);
};

'use strict';
// Unit-test harness (not a test): an isolated zcode root, a fixture "live"
// desktop dir, and the scripted fake engine (test/fixtures/fake-engine.js).
// Nothing here spawns bin/zcode.js, touches the real ~/.zcode, or calls a
// model. Env is set on process.env because the engine child inherits it.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const FAKE_ENGINE = path.join(__dirname, '..', 'fixtures', 'fake-engine.js');
const TEST_KEY = 'test-key-0123456789';

function setupFake(script = { turns: [{ response: 'ok' }] }) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-unit-')));
  const root = path.join(base, 'root');
  const live = path.join(base, 'live');
  const work = path.join(base, 'work');
  fs.mkdirSync(path.join(live, 'v2'), { recursive: true });
  fs.mkdirSync(path.join(live, 'cli'), { recursive: true });
  fs.mkdirSync(path.join(live, 'skills', 'demo'), { recursive: true });
  fs.mkdirSync(work, { recursive: true });
  fs.writeFileSync(
    path.join(live, 'v2', 'provider_config.json'),
    JSON.stringify({
      config: {
        providerConfigRules: {
          providerRules: [
            { providerId: 'other', config: {} },
            { providerId: 'zai-api', config: { access: { type: 'oauth' } } },
          ],
        },
      },
    })
  );
  fs.writeFileSync(path.join(live, 'v2', 'setting.json'), '{}');
  fs.writeFileSync(path.join(live, 'v2', 'credentials.json'), '{"oauth":"live-secret"}');
  fs.writeFileSync(
    path.join(live, 'cli', 'config.json'),
    JSON.stringify({ mcp: { servers: { desk: { type: 'http', url: 'http://x' } } } })
  );
  fs.writeFileSync(path.join(live, 'skills', 'demo', 'SKILL.md'), '---\nname: demo\n---\n');
  fs.writeFileSync(path.join(live, 'AGENTS.md'), '# agents\n');
  const builtin = path.join(base, 'zcode-builtin.json');
  fs.writeFileSync(builtin, '{}');
  const scriptFile = path.join(base, 'script.json');
  const log = path.join(base, 'engine.log');
  const state = path.join(base, 'engine.state');
  fs.writeFileSync(scriptFile, JSON.stringify(script));

  Object.assign(process.env, {
    ZAI_CODE_HOME: root,
    ZAI_CODE_LIVE_DIR: live,
    ZAI_CODE_ENGINE: FAKE_ENGINE,
    ZAI_CODE_BUILTIN_PROVIDER_CONFIG: builtin,
    ZAI_API_KEY: TEST_KEY,
    FAKE_ENGINE_SCRIPT: scriptFile,
    FAKE_ENGINE_LOG: log,
    FAKE_ENGINE_STATE: state,
  });
  delete process.env.ZAI_CODE_NODE;

  return {
    base,
    root,
    live,
    work,
    setScript: (s) => fs.writeFileSync(scriptFile, JSON.stringify(s)),
    resetEngineState: () => fs.rmSync(state, { force: true }),
    log: () => {
      try {
        return fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
      } catch {
        return [];
      }
    },
    cleanup: () => fs.rmSync(base, { recursive: true, force: true }),
  };
}

// A handback block as the model would write it.
function handback(obj) {
  return `Report text.\n\n\`\`\`zcode-handback\n${JSON.stringify(obj)}\n\`\`\``;
}

// A complete invocation with defaults, as lib/commands/exec.js builds it.
function invocation(fake, { contract: contractOverrides, ...overrides } = {}) {
  const kind = overrides.kind || 'task';
  const contract = {
    objective: 'do the thing',
    scope: [], constraints: [], design: [], acceptance: [], checks: [], files: [],
    references: [], context: [], owns: [], limits: {}, model: null, effort: null,
    ...(contractOverrides || {}),
  };
  const ownsDisplay = overrides.ownsDisplay || contract.owns;
  return {
    kind,
    id: overrides.id || `t-${Math.random().toString(16).slice(2, 10)}`,
    cwd: fake.work,
    model: 'GLM-5.3-Flash',
    effort: 'max',
    timeoutMs: 20000,
    maxRepairs: 2,
    checkTimeoutMs: 10000,
    checks: contract.checks,
    owns: ownsDisplay,
    ownsDisplay,
    acceptanceDeclared: contract.acceptance.length > 0,
    mcpSpecs: [],
    mcpInherit: false,
    skillsDirs: [],
    noSkills: false,
    profile: 'general-purpose',
    includeReasoning: false,
    allowOverlap: false,
    stream: false,
    contract: kind === 'task' ? contract : undefined,
    prompt: kind === 'task' ? undefined : 'hello',
    ...overrides,
  };
}

module.exports = { setupFake, handback, invocation, TEST_KEY, FAKE_ENGINE };

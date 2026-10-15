'use strict';
// TDD step 3 — doctor builds the isolation scratch; live credential-bearing
// config files are untouched (DESIGN §6.2, §6.4). Offline (no model call),
// but touches the real ~/.zcode sources read-only and the real ~/.zcode.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  readFileSync,
  existsSync,
  statSync,
  readdirSync,
} = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { cli, loadEnvKey } = require('../helpers/env.js');

const LIVE_V2 = path.join(os.homedir(), '.zcode', 'v2');
const LIVE_V2_PROVIDER_CONFIG = path.join(LIVE_V2, 'provider_config.json');
const LIVE_CLI_CONFIG = path.join(os.homedir(), '.zcode', 'cli', 'config.json');

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function providerRulesOf(file) {
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  return parsed.config.providerConfigRules.providerRules;
}

// Recursively collect relative paths under dir.
function walk(dir, prefix = '') {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walk(path.join(dir, entry.name), rel));
    else out.push(rel);
  }
  return out;
}

test('doctor --json --fresh builds isolation without touching live config', async () => {
  const key = loadEnvKey();
  assert.ok(key, 'test API key must be loadable from .env for this test');

  const before = {};
  for (const [name, file] of [
    ['liveV2ProviderConfig', LIVE_V2_PROVIDER_CONFIG],
    ['liveCliConfig', LIVE_CLI_CONFIG],
  ]) {
    if (existsSync(file)) before[name] = statSync(file);
  }

  const { code, stdout, stderr } = await cli(['doctor', '--json', '--fresh'], {
    timeoutMs: 120000,
  });
  assert.equal(code, 0, `stderr: ${stderr}\nstdout: ${stdout}`);

  const report = JSON.parse(stdout.trim().split('\n').pop());
  assert.ok(existsSync(report.engine.path), 'doctor-reported engine path exists');
  assert.ok(
    existsSync(report.engine.builtinProviderConfig),
    'doctor-reported builtin provider config exists'
  );

  // 0.4: doctor builds its probe engine HOME exactly like a session's.
  const SCRATCH_HOME = report.isolation.home;
  const SCRATCH_PROVIDER_CONFIG = path.join(SCRATCH_HOME, '.zcode', 'v2', 'provider_config.json');

  // Scratch provider_config.json: exists, mode <= 600, exactly the zai-api
  // rule, key == loaded key != live key (sha256 comparisons only).
  assert.ok(existsSync(SCRATCH_PROVIDER_CONFIG), 'scratch provider_config.json exists');
  const scratchMode = statSync(SCRATCH_PROVIDER_CONFIG).mode & 0o777;
  assert.ok(
    scratchMode <= 0o600,
    `scratch provider_config.json mode ${scratchMode.toString(8)} <= 600`
  );
  const rules = providerRulesOf(SCRATCH_PROVIDER_CONFIG);
  assert.equal(rules.length, 1, 'exactly one provider rule in scratch');
  assert.equal(rules[0].providerId, 'zai-api');
  assert.equal(rules[0].config.access.type, 'api-key');
  const scratchKeySha = sha256(rules[0].config.access.apiKey);
  assert.equal(scratchKeySha, sha256(key), 'scratch key == loaded key (sha256)');
  if (existsSync(LIVE_V2_PROVIDER_CONFIG)) {
    const liveRules = providerRulesOf(LIVE_V2_PROVIDER_CONFIG);
    const zaiRule = liveRules.find((r) => r.providerId === 'zai-api');
    if (zaiRule && zaiRule.config.access.apiKey) {
      assert.notEqual(
        scratchKeySha,
        sha256(zaiRule.config.access.apiKey),
        'scratch key != live key (sha256)'
      );
    }
  }

  // No credentials.json anywhere under the scratch HOME.
  const files = walk(SCRATCH_HOME);
  const creds = files.filter((f) => path.basename(f) === 'credentials.json');
  assert.deepEqual(creds, [], 'no credentials.json anywhere in scratch');

  // Copied agent profiles present for custom-profile resolution (§6.2 item 4).
  if (existsSync(path.join(os.homedir(), '.zcode', 'AGENTS.md'))) {
    assert.ok(
      existsSync(path.join(SCRATCH_HOME, '.zcode', 'AGENTS.md')),
      'AGENTS.md copied into scratch'
    );
  }

  // Live credential-bearing config files untouched (scoped per §6.4).
  for (const [name, file] of [
    ['liveV2ProviderConfig', LIVE_V2_PROVIDER_CONFIG],
    ['liveCliConfig', LIVE_CLI_CONFIG],
  ]) {
    if (!before[name]) continue;
    const after = statSync(file);
    assert.equal(
      after.mtimeMs,
      before[name].mtimeMs,
      `${file} mtime unchanged by doctor`
    );
  }
});

'use strict';
// Shared test infrastructure (not a test): loads the repo .env's hyphenated
// API-KEY line (never printing it) and exposes cli(args, opts) which spawns
// bin/zcode.js as a real child process.
const { readFileSync, existsSync, statSync } = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..', '..');
const binPath = path.join(repoRoot, 'bin', 'zcode.js');
const DEFAULT_ENGINE = '/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs';

// Parse .env line-wise: the variable is hyphenated ("API-KEY=..."), so
// dotenv-style parsing does not apply. Value is never echoed anywhere.
function loadEnvKey() {
  const envPath = path.join(repoRoot, '.env');
  let text;
  try {
    text = readFileSync(envPath, 'utf8');
  } catch {
    return '';
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith('API-KEY=')) continue;
    let value = line.slice('API-KEY='.length).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    return value;
  }
  return '';
}

// Fail fast with a clear message when the preconditions for live tests are
// missing. Returns {engine, engineOk}.
function checkEngine() {
  const engine = process.env.ZAI_CODE_ENGINE || DEFAULT_ENGINE;
  let engineOk = false;
  try {
    engineOk = statSync(engine).isFile();
  } catch {
    engineOk = false;
  }
  return { engine, engineOk };
}

// Spawn the CLI. Resolves {code, stdout, stderr} when the child exits, or
// rejects with a Timeout when timeoutMs elapses (child is SIGKILLed).
// opts.env overlays process.env (explicit keys, including '', win).
function cli(args, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 600000;
  return new Promise((resolve, reject) => {
    const env = { ...process.env, ...(opts.env || {}) };
    const key = loadEnvKey();
    if (key && env.ZAI_API_KEY === undefined) env.ZAI_API_KEY = key;
    const child = spawn(process.execPath, [binPath, ...args], {
      cwd: opts.cwd || repoRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`cli timed out after ${timeoutMs}ms: ${JSON.stringify(args)}`));
    }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

module.exports = { cli, loadEnvKey, checkEngine, repoRoot, binPath };

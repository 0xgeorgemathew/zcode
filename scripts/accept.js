#!/usr/bin/env node
'use strict';
// Acceptance runners — the project's definition of done. Run them verbatim
// via the npm scripts accept:flash / accept:subagent / accept:53 (they need
// the engine and a repo .env key). Each mode drives bin/zcode.js as a black box against the
// real GLM API with --effort max, tees the CLI's --json output through (so
// subagent completion is visible), verifies deterministic evidence, and
// prints a final "SUCCESS <token>" line — exit 0 only on success.
//
// The API key is loaded from the repo .env (variable name "API-KEY",
// hyphenated → line-parsed) and is never printed.
const { spawn } = require('node:child_process');
const {
  readFileSync,
  mkdtempSync,
  rmSync,
  existsSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const binPath = path.join(repoRoot, 'bin', 'zcode.js');
const ENGINE = '/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs';

const ONE_SHOT_PROMPT = 'Reply with exactly the word PINEAPPLE and nothing else.';
const SUBAGENT_PROMPT =
  'Use the Agent tool to create the file done.txt in the current directory containing exactly AVOCADO, then report the agent id.';

const MODES = {
  flash: {
    label: 'accept:flash (one-shot via GLM-5.3-Flash, effort max)',
    prompt: ONE_SHOT_PROMPT,
    token: 'PINEAPPLE',
    expectedModel: 'GLM-5.3-Flash',
    cliArgs: ['--json', '--effort', 'max', '--model', 'glm-5.3-flash'],
    timeoutMs: 300000,
  },
  glm53: {
    label: 'accept:53 (one-shot via GLM-5.3, effort max)',
    prompt: ONE_SHOT_PROMPT,
    token: 'PINEAPPLE',
    expectedModel: 'GLM-5.3',
    cliArgs: ['--json', '--effort', 'max', '--model', 'glm-5.3'],
    timeoutMs: 300000,
  },
  subagent: {
    label: 'accept:subagent (subagent does real work, effort max)',
    prompt: SUBAGENT_PROMPT,
    token: 'AVOCADO',
    expectedModel: 'GLM-5.3-Flash',
    cliArgs: [
      'agent', '--json', '--effort', 'max', '--profile', 'general-purpose',
    ],
    timeoutMs: 480000,
  },
};

function loadKey() {
  const envPath = path.join(repoRoot, '.env');
  let text;
  try {
    text = readFileSync(envPath, 'utf8');
  } catch {
    return '';
  }
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.startsWith('API-KEY=')) continue;
    return raw.slice('API-KEY='.length).trim();
  }
  return '';
}

// Spawns the CLI, tees stdout through, resolves {code, stdout, timedOut}.
function runCli(args, { env, timeoutMs }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [binPath, ...args], {
      cwd: repoRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ code: -1, stdout, timedOut: true });
    }, timeoutMs);
    child.stdout.on('data', (d) => {
      stdout += d;
      process.stdout.write(d);
    });
    child.stderr.on('data', (d) => process.stderr.write(d));
    child.on('error', (err) => finish({ code: -1, stdout, error: err }));
    child.on('close', (code) => finish({ code, stdout, timedOut: false }));
  });
}

function parseResultLine(stdout) {
  const lines = stdout.split('\n').filter((l) => l.trim());
  if (lines.length === 0) return null;
  try {
    return JSON.parse(lines[lines.length - 1]);
  } catch {
    return null;
  }
}

// Deterministic verification. Returns {ok} | {hardFail} | {retry, why}.
function verify(mode, { code, stdout, timedOut, work }) {
  if (code === 2 || code === 3 || code === 4) {
    return { hardFail: `config error exit ${code} (see stderr above)` };
  }
  if (timedOut) return { retry: 'transport timeout' };
  if (code !== 0) return { retry: `CLI exited ${code}` };

  const result = parseResultLine(stdout);
  if (!result || result.type !== 'result' || result.ok !== true) {
    return { retry: `no successful result line: ${JSON.stringify(result).slice(0, 300)}` };
  }
  if (mode === MODES.subagent) {
    // The parent's response is a prose report; the forced token for this
    // mode is the ARTIFACT content, verified below.
    if (!(result.response || '').trim()) {
      return { retry: 'empty parent response' };
    }
  } else if ((result.response || '').trim() !== mode.token) {
    return {
      retry: `response mismatch: ${JSON.stringify(result.response).slice(0, 200)}`,
    };
  }
  if (result.model !== mode.expectedModel) {
    return {
      retry: `engine-reported model ${result.model} != ${mode.expectedModel}`,
    };
  }
  if (result.effort !== 'max') {
    return { retry: `engine-reported effort ${result.effort} != max` };
  }

  if (mode === MODES.subagent) {
    if (result.mode !== 'yolo') {
      return { hardFail: `session mode ${result.mode} != yolo` };
    }
    const subagents = Array.isArray(result.subagents) ? result.subagents : [];
    if (subagents.length < 1) {
      return { retry: 'no subagent dispatched' };
    }
    for (const sa of subagents) {
      if (sa.status !== 'success') {
        return { retry: `subagent ${sa.agentId} status ${sa.status}` };
      }
      if (!sa.agentId || !sa.childSessionId) {
        return { retry: 'subagent record missing agentId/childSessionId' };
      }
    }
    // The subagent's real work: the artifact, inside the session cwd.
    const artifact = path.join(work, 'done.txt');
    if (!existsSync(artifact)) {
      return { retry: 'done.txt not created inside --cwd' };
    }
    const content = readFileSync(artifact, 'utf8');
    if (content !== mode.token) {
      return {
        retry: `done.txt content mismatch: ${JSON.stringify(content)}`,
      };
    }
  }
  return { ok: true };
}

async function main() {
  const modeName = process.argv[2];
  const mode = MODES[modeName];
  if (!mode) {
    process.stderr.write(
      `usage: node scripts/accept.js <flash|subagent|glm53>\n`
    );
    process.exit(2);
  }

  const key = loadKey();
  if (!key) {
    process.stderr.write('accept: no API-KEY found in .env at the repo root\n');
    process.exit(1);
  }
  if (!existsSync(process.env.ZAI_CODE_ENGINE || ENGINE)) {
    process.stderr.write(
      `accept: engine not found at ${process.env.ZAI_CODE_ENGINE || ENGINE} (set ZAI_CODE_ENGINE)\n`
    );
    process.exit(1);
  }

  process.stderr.write(`accept: ${mode.label}\n`);
  const env = { ...process.env, ZAI_API_KEY: key };

  let lastWhy = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    const work = mkdtempSync(path.join(tmpdir(), `zcode-accept-${modeName}-`));
    try {
      if (attempt > 1) process.stderr.write(`accept: retry after: ${lastWhy}\n`);
      const args = [...mode.cliArgs, '--cwd', work, '--timeout-ms', String(mode.timeoutMs - 60000), mode.prompt];
      const run = await runCli(args, {
        env,
        timeoutMs: mode.timeoutMs,
      });
      const verdict = verify(mode, { ...run, work });
      if (verdict.ok) {
        process.stdout.write(`SUCCESS ${mode.token}\n`);
        process.exit(0);
      }
      if (verdict.hardFail) {
        process.stderr.write(`accept: FAILED (no retry): ${verdict.hardFail}\n`);
        process.exit(1);
      }
      lastWhy = verdict.retry;
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }
  process.stderr.write(`accept: FAILED: ${lastWhy}\n`);
  process.exit(1);
}

main().catch((err) => {
  process.stderr.write(`accept: internal error: ${err && err.stack ? err.stack : err}\n`);
  process.exit(1);
});

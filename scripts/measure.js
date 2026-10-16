#!/usr/bin/env node
'use strict';
// Output-size and latency probe for the orchestrator-facing surface. Drives
// bin/zcode.js as a black box against the scripted fake engine (no model, no
// network, no real ~/.zcode) and records what an orchestrator would have to
// read:
//
//   resultBytes       the final `--json` line of a task with two checks
//                     (one passing, one failing, repairs off)
//   waitTimeoutBytes  stdout+stderr of `wait --json` timing out on
//                     `waitSessions` still-running sessions
//   promptBytes       the executor task prompt for a representative contract
//                     (--file X plus --context @X naming the same file)
//   wallMs            median wall time of the task run (3 runs)
//
//   node scripts/measure.js                       print the numbers
//   node scripts/measure.js --write FILE          record a baseline
//   node scripts/measure.js --compare FILE        before/after; exit 1 when a gate fails
//
// Gates (docs/baseline.json was measured on v0.4.4, before any v0.5 change):
//   result line  <= 20% of baseline
//   wait timeout <= 120 bytes per pending session
//   prompt       <= baseline bytes + PROMPT_ALLOWANCE, where the allowance is
//                the size budget for sections that render on EVERY task prompt
//                since v0.5 (today: "Session environment", <= 400 bytes).
//                The prompt is measured as the executor receives it, i.e.
//                with the session environment section. Optional sections
//                (decisions, units, visual, touch) are not part of the
//                baseline contract and cost nothing unless asked for.
//   wall time    <= baseline + 5% (+300 ms absolute slack)
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { setupFake, handback } = require('../test/helpers/fake.js');

const repoRoot = path.resolve(__dirname, '..');
const BIN = path.join(repoRoot, 'bin', 'zcode.js');
const PROMPT_ALLOWANCE = 400;
const WAIT_SESSIONS = 2;
const WAIT_BYTES_PER_SESSION = 120;
const RUNS = 3;

function run(args, { cwd, timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(process.execPath, [BIN, ...args], { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`timed out: ${args.join(' ')}`));
    }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, ms: Date.now() - started });
    });
  });
}

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

async function measureTask(fake) {
  fake.setScript({
    turns: [{
      write: { path: 'out/a.txt', content: 'hello\n' },
      tool: 'Write',
      response: handback({
        status: 'done',
        summary: 'Created out/a.txt with the requested content.',
        changes: [{ path: 'out/a.txt', what: 'new file' }],
        checks: [{ what: 'test -f out/a.txt', result: 'pass', evidence: 'exists' }],
        criteria: [{ criterion: 'a.txt exists', met: true, evidence: 'ls' }],
        notes: 'nothing further',
      }),
    }],
  });
  const times = [];
  let line = '';
  let total = 0;
  for (let i = 0; i < RUNS; i++) {
    const cwd = fs.mkdtempSync(path.join(fake.base, 'task-'));
    fake.resetEngineState();
    // Checks print like real test runners do (the old record kept every
    // check's output, passing or not) but have short, realistic commands.
    const script = (name, body) => {
      fs.writeFileSync(path.join(cwd, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    };
    script('check-unit.sh', 'test -f out/a.txt && i=1 && while [ $i -le 30 ]; do echo "ok $i - page renders section $i"; i=$((i+1)); done');
    script('check-e2e.sh', 'printf "FAIL tests/e2e.test.js\\n  expected 3 plans, got 2\\nTests: 1 failed, 1 total\\n" >&2; exit 3');
    const r = await run([
      'task', '--json', '--id', `measure-task-${i}`, '--cwd', cwd, '--max-repairs', '0',
      '--check', './check-unit.sh',
      '--check', './check-e2e.sh',
      '--accept', 'out/a.txt exists',
      'Create out/a.txt containing hello',
    ]);
    times.push(r.ms);
    const lines = r.stdout.split('\n').filter(Boolean);
    line = lines[lines.length - 1] || '';
    total = Buffer.byteLength(r.stdout);
  }
  return { resultBytes: Buffer.byteLength(line), stdoutBytes: total, wallMs: median(times) };
}

async function measureWait(fake) {
  fake.setScript({ turns: [{ hang: true, response: 'never' }] });
  fake.resetEngineState();
  const ids = [];
  for (let i = 0; i < WAIT_SESSIONS; i++) {
    const cwd = fs.mkdtempSync(path.join(fake.base, 'wait-'));
    const id = `measure-wait-${i}`;
    ids.push(id);
    const r = await run(['task', '--detach', '--json', '--id', id, '--cwd', cwd, '--owns', `s${i}/**`, 'Wait forever']);
    if (r.code !== 0) throw new Error(`detach failed: ${r.stderr}`);
  }
  // Let the workers reach the hanging turn so the state is a realistic "running".
  await new Promise((r) => setTimeout(r, 1500));
  const w = await run(['wait', '--json', '--timeout-ms', '800', ...ids]);
  for (const id of ids) await run(['cancel', id]);
  if (w.code !== 124) throw new Error(`wait did not time out (exit ${w.code}): ${w.stdout}${w.stderr}`);
  return { waitTimeoutBytes: Buffer.byteLength(w.stdout) + Buffer.byteLength(w.stderr), waitSessions: WAIT_SESSIONS };
}

function measurePrompt() {
  const { buildTaskPrompt } = require('../lib/contract.js');
  const spec = fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8').slice(0, 3000);
  const specFile = 'README.md'; // --file README.md and --context @README.md: the same file twice
  const contract = {
    objective: 'Implement the pricing page from the spec.',
    scope: ['pricing page only'], constraints: ['no new dependencies'], design: [],
    acceptance: ['page renders three plans', 'CTA links to /signup'],
    checks: ['npm test', 'npm run build'],
    files: [specFile, 'src/app.js'],
    references: [], context: [spec], owns: ['src/pricing/**'], limits: {}, model: null, effort: null,
  };
  const ownsDisplay = ['src/pricing/**'];
  const bare = buildTaskPrompt(contract, { ownsDisplay });
  const sample = {
    id: 'zc-sample', port: 41234, out: '/work/.zcode/out/zc-sample', tmp: '/tmp/zcode-zc-sample',
  };
  let full = bare;
  try {
    full = buildTaskPrompt(contract, { ownsDisplay, session: sample });
  } catch {
    /* pre-0.5 contract.js ignores the option */
  }
  return { promptBytes: Buffer.byteLength(bare), promptWithSessionBytes: Buffer.byteLength(full) };
}

function gates(base, now) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });
  add('result <= 20% of baseline', now.resultBytes <= base.resultBytes * 0.2,
    `${now.resultBytes} B vs ${base.resultBytes} B (${((now.resultBytes / base.resultBytes) * 100).toFixed(1)}%)`);
  const perSession = now.waitTimeoutBytes / now.waitSessions;
  add(`wait timeout <= ${WAIT_BYTES_PER_SESSION} B/session`, perSession <= WAIT_BYTES_PER_SESSION,
    `${now.waitTimeoutBytes} B for ${now.waitSessions} sessions (${perSession.toFixed(0)} B each; baseline ${base.waitTimeoutBytes} B)`);
  add('prompt (bare contract) <= baseline', now.promptBytes <= base.promptBytes, `${now.promptBytes} B vs ${base.promptBytes} B`);
  add(`prompt as sent <= baseline + ${PROMPT_ALLOWANCE} B (always-on sections)`,
    now.promptWithSessionBytes <= base.promptBytes + PROMPT_ALLOWANCE,
    `${now.promptWithSessionBytes} B vs ${base.promptBytes} B + ${PROMPT_ALLOWANCE}`);
  add('wall time <= baseline +5% (+300 ms)', now.wallMs <= base.wallMs * 1.05 + 300, `${now.wallMs} ms vs ${base.wallMs} ms`);
  return checks;
}

async function measure() {
  // A short tmp root keeps the session paths in the output close to a real
  // ~/.zcode/sessions/<id>/ path instead of macOS's long /var/folders/… dir.
  if (fs.existsSync('/tmp')) process.env.TMPDIR = '/tmp';
  const fake = setupFake();
  try {
    const task = await measureTask(fake);
    const wait = await measureWait(fake);
    return { schema: 'zcode.measure/1', ...task, ...wait, ...measurePrompt() };
  } finally {
    fake.cleanup();
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const now = await measure();
  const wi = argv.indexOf('--write');
  const ci = argv.indexOf('--compare');
  if (wi >= 0) {
    const file = path.resolve(argv[wi + 1]);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(now, null, 2) + '\n');
    process.stdout.write(`wrote ${file}\n${JSON.stringify(now, null, 2)}\n`);
    return;
  }
  if (ci >= 0) {
    const base = JSON.parse(fs.readFileSync(path.resolve(argv[ci + 1]), 'utf8'));
    const rows = gates(base, now);
    for (const r of rows) process.stdout.write(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}: ${r.detail}\n`);
    process.stdout.write(`\nbefore ${JSON.stringify(base)}\nafter  ${JSON.stringify(now)}\n`);
    process.exit(rows.every((r) => r.ok) ? 0 : 1);
  }
  process.stdout.write(JSON.stringify(now, null, 2) + '\n');
}

main().catch((err) => {
  process.stderr.write(`measure: ${err.stack || err}\n`);
  process.exit(1);
});

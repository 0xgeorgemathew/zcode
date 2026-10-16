'use strict';
// Acceptance checks: shell commands from the task contract that zcode runs
// ITSELF after the model's turn — the model's own claims are never the
// verification evidence. Each check runs in its own process group (so a
// timeout or cancel kills the whole tree), with a per-check timeout and a
// bounded output tail. CI=1 is set when unset so test runners do not enter
// watch/interactive mode.
const { spawn } = require('node:child_process');

const OUTPUT_TAIL = 4000;

function killGroup(child) {
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      /* gone */
    }
  }
}

function runCheck(command, { cwd, timeoutMs = 300000, signal, env = process.env } = {}) {
  env = env || process.env;
  const started = Date.now();
  return new Promise((resolve) => {
    let output = '';
    let timedOut = false;
    let cancelled = false;
    const keep = (chunk) => {
      output += chunk;
      if (output.length > OUTPUT_TAIL * 2) output = output.slice(-OUTPUT_TAIL);
    };
    let child;
    try {
      child = spawn('/bin/sh', ['-c', command], {
        cwd,
        env: { ...env, CI: env.CI ?? '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      });
    } catch (err) {
      resolve({ command, ok: false, exitCode: null, timedOut: false, durationMs: 0, output: String(err.message) });
      return;
    }
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child);
    }, timeoutMs);
    const onAbort = () => {
      cancelled = true;
      killGroup(child);
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    const finish = (exitCode, errText) => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      const tail = (output + (errText ? `\n${errText}` : '')).slice(-OUTPUT_TAIL);
      resolve({
        command,
        ok: exitCode === 0 && !timedOut && !cancelled,
        exitCode,
        timedOut,
        cancelled,
        durationMs: Date.now() - started,
        output: tail,
      });
    };
    child.on('error', (err) => finish(null, err.message));
    child.on('close', (code) => finish(code));
  });
}

// Runs every check in order (later checks still run when an earlier one
// fails, so the handback carries complete evidence); stops on cancel.
async function runChecks(commands, { cwd, timeoutMs, signal, env, onEvent = () => {} } = {}) {
  const results = [];
  for (const command of commands) {
    if (signal && signal.aborted) break;
    onEvent({ type: 'check', phase: 'started', command });
    const r = await runCheck(command, { cwd, timeoutMs, signal, env });
    results.push(r);
    onEvent({
      type: 'check',
      phase: 'finished',
      command,
      ok: r.ok,
      exitCode: r.exitCode,
      timedOut: r.timedOut,
      durationMs: r.durationMs,
    });
  }
  return results;
}

module.exports = { runCheck, runChecks, OUTPUT_TAIL };

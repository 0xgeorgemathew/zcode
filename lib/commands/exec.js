'use strict';
// lib/commands/exec.js — run | task | agent | resume | __exec (detached
// worker). Builds the invocation from argv, runs it (in-process, or in a
// detached worker with --detach), prints the result, exits with the
// status's exit code.
//
// Output contract:
//   --json   stdout = NDJSON events + exactly one final {"type":"result"}
//            line (--quiet: only that line). stderr = diagnostics only.
//   plain    stdout = the answer (run/agent) or the handback summary (task);
//            stderr = the live feed (header, phases, tools, checks).
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const store = require('../store.js');
const { execute, prepareSession, exitCodeFor, ExecError, readSettings } = require('../executor.js');
const { ConfigError } = require('../bootstrap.js');
const { normalizeContract, ContractError } = require('../contract.js');
const { workspaceRoot, normalizeOwns, OwnershipError } = require('../workspace.js');
const { makeReporter, formatResult, useColor } = require('../ui.js');
const { normalizeModel, normalizeEffort } = require('../models.js');

const BIN = path.join(__dirname, '..', '..', 'bin', 'zcode.js');
const DEFAULT_TIMEOUT = { run: 600000, agent: 600000, task: 1800000 };

function usage(message) {
  process.stderr.write(`zcode: ${message}\n`);
  process.exit(2);
}

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

// --task <file|->: .json (or text starting with "{") is a contract object,
// anything else is a markdown brief that becomes the objective.
function loadTaskBase(spec) {
  if (spec === undefined) return {};
  const text = spec === '-' ? readStdin() : (() => {
    try {
      return fs.readFileSync(spec, 'utf8');
    } catch {
      return usage(`--task file "${spec}" could not be read.`);
    }
  })();
  const trimmed = text.trim();
  if (spec.endsWith('.json') || trimmed.startsWith('{')) {
    try {
      return JSON.parse(trimmed);
    } catch (err) {
      return usage(`--task JSON is invalid: ${err.message}`);
    }
  }
  return { objective: trimmed };
}

function buildInvocation(parsed) {
  const { command, flags, prompts } = parsed;
  const kind = command;
  const inv = {
    kind,
    id: flags.id || store.newId(),
    label: flags.label || null,
    cwd: path.resolve(flags.cwd),
    model: flags.model,
    effort: flags.effort,
    timeoutMs: flags.timeoutMs ?? DEFAULT_TIMEOUT[kind],
    maxRepairs: flags.maxRepairs ?? 2,
    checkTimeoutMs: flags.checkTimeoutMs ?? 300000,
    checks: [],
    owns: [],
    ownsDisplay: flags.owns,
    acceptanceDeclared: false,
    mcpSpecs: flags.mcpSpecs,
    mcpInherit: flags.mcpInherit,
    skillsDirs: flags.skillsDirs.map((d) => path.resolve(d)),
    noSkills: flags.noSkills,
    profile: flags.profile,
    includeReasoning: flags.includeReasoning,
    allowOverlap: flags.allowOverlap,
    stream: kind !== 'task' || flags.stream,
  };

  if (kind === 'task') {
    const objective = prompts.join(' ');
    let base = loadTaskBase(flags.task);
    if (!objective.trim() && flags.task === undefined && !process.stdin.isTTY) {
      base = { objective: readStdin().trim() };
    }
    let contract;
    try {
      contract = normalizeContract(base, {
        objective,
        acceptance: flags.accept,
        checks: flags.check,
        files: flags.file,
        context: flags.context,
        owns: flags.owns,
      });
    } catch (err) {
      if (err instanceof ContractError) usage(err.message);
      throw err;
    }
    // Contract-level model/effort/limits apply unless a flag overrides them.
    if (contract.model && !parsed.given.has('model')) {
      inv.model = normalizeModel(contract.model) || usage(`contract model "${contract.model}" is not supported.`);
    }
    if (contract.effort && !parsed.given.has('effort')) {
      inv.effort = normalizeEffort(contract.effort) || usage(`contract effort "${contract.effort}" is not valid.`);
    }
    const lim = contract.limits;
    if (lim.timeoutMs && !parsed.given.has('timeoutMs')) inv.timeoutMs = lim.timeoutMs;
    if (lim.maxRepairs !== undefined && !parsed.given.has('maxRepairs')) inv.maxRepairs = lim.maxRepairs;
    if (lim.checkTimeoutMs && !parsed.given.has('checkTimeoutMs')) inv.checkTimeoutMs = lim.checkTimeoutMs;
    inv.contract = contract;
    inv.checks = contract.checks;
    inv.ownsDisplay = contract.owns;
    inv.acceptanceDeclared = contract.acceptance.length > 0;
  } else {
    let prompt = prompts.join(' ');
    if (!prompt && kind === 'run' && !process.stdin.isTTY) prompt = readStdin();
    if (!prompt.trim()) usage(kind === 'agent' ? 'agent needs instructions.' : 'no prompt given (positional args or stdin).');
    inv.prompt = prompt;
  }

  try {
    inv.owns = normalizeOwns(inv.ownsDisplay, inv.cwd, workspaceRoot(inv.cwd));
  } catch (err) {
    if (err instanceof OwnershipError) usage(err.message);
    throw err;
  }
  return inv;
}

// resume <id> [message] — or run --session <id> <prompt> (0.3 compat).
function buildResume(parsed, ref, message) {
  const id = store.resolveSessionId(ref);
  if (!id) usage(`no session "${ref}" (see "zcode status").`);
  const settings = readSettings(id);
  if (!settings) usage(`session "${id}" has no stored settings; it cannot be resumed.`);
  const { flags, given } = parsed;
  if (settings.kind !== 'task' && !message.trim()) usage(`resume of a ${settings.kind} session needs a message.`);
  return {
    ...settings,
    id,
    resume: { message },
    model: given.has('model') ? flags.model : settings.model,
    effort: given.has('effort') ? flags.effort : settings.effort,
    timeoutMs: given.has('timeoutMs') ? flags.timeoutMs : settings.timeoutMs,
    maxRepairs: given.has('maxRepairs') ? flags.maxRepairs : settings.maxRepairs,
    checkTimeoutMs: given.has('checkTimeoutMs') ? flags.checkTimeoutMs : settings.checkTimeoutMs,
    includeReasoning: flags.includeReasoning,
    stream: settings.kind !== 'task' || flags.stream,
    contract: settings.kind === 'task' ? readTask(id) : undefined,
  };
}

function readTask(id) {
  try {
    return JSON.parse(fs.readFileSync(path.join(store.sessionDir(id), 'task.json'), 'utf8'));
  } catch {
    return null;
  }
}

// --detach: claim the id, hand the invocation to a detached worker
// (`zcode __exec <id>`), print the handle, exit 0. The worker writes its
// NDJSON to <session>/stdout.ndjson and diagnostics to stderr.log.
function detach(inv, flags) {
  if (inv.resume) {
    const view = store.viewSession(store.readSession(inv.id));
    if (view && view.live) {
      process.stderr.write(`zcode: session "${inv.id}" is still running (pid ${view.pid}).\n`);
      process.exit(7);
    }
  } else {
    try {
      prepareSession(inv);
    } catch (err) {
      if (err instanceof store.SessionExistsError) usage(err.message);
      throw err;
    }
  }
  const dir = store.sessionDir(inv.id);
  store.writeJsonAtomic(path.join(dir, 'pending.json'), inv);
  // Mark it queued (owned by us) BEFORE the worker exists, so a concurrent
  // `zcode wait` never mistakes a previous invocation's result for this one.
  store.updateSession(inv.id, { state: 'queued', phase: 'queued', pid: process.pid, status: null });
  const out = fs.openSync(path.join(dir, 'stdout.ndjson'), 'a', 0o600);
  const err = fs.openSync(path.join(dir, 'stderr.log'), 'a', 0o600);
  const child = spawn(process.execPath, [BIN, '__exec', inv.id], {
    cwd: inv.cwd,
    detached: true,
    stdio: ['ignore', out, err],
    env: process.env,
  });
  child.unref();
  store.updateSession(inv.id, { state: 'queued', phase: 'queued', pid: child.pid, status: null });
  const handle = {
    type: 'detached',
    id: inv.id,
    pid: child.pid,
    kind: inv.kind,
    status: 'queued',
    files: { session: dir, stdout: path.join(dir, 'stdout.ndjson'), stderr: path.join(dir, 'stderr.log') },
  };
  if (flags.json) process.stdout.write(JSON.stringify(handle) + '\n');
  else {
    process.stdout.write(`${inv.id}\n`);
    if (!flags.quiet) {
      process.stderr.write(`zcode: started ${inv.id} in the background (pid ${child.pid}). zcode status ${inv.id} · zcode wait ${inv.id}\n`);
    }
  }
  process.exit(0);
}

module.exports = async function exec(parsed) {
  const { command, flags } = parsed;
  let inv;
  let worker = false;
  if (command === '__exec') {
    worker = true;
    const id = parsed.prompts[0];
    const file = path.join(store.sessionDir(id), 'pending.json');
    try {
      inv = JSON.parse(fs.readFileSync(file, 'utf8'));
      fs.rmSync(file, { force: true });
    } catch {
      usage(`no pending invocation for "${id}".`);
    }
    inv.adopt = true;
  } else if (command === 'resume') {
    const [ref, ...rest] = parsed.prompts;
    if (!ref) usage('resume needs a session id.');
    // `zcode resume <id> -` reads the message from stdin (long answers).
    const message = rest.length === 1 && rest[0] === '-' ? readStdin() : rest.join(' ');
    inv = buildResume(parsed, ref, message);
  } else if (command === 'run' && flags.session) {
    inv = buildResume(parsed, flags.session, parsed.prompts.join(' ') || (!process.stdin.isTTY ? readStdin() : ''));
  } else {
    inv = buildInvocation(parsed);
  }

  if (flags.detach && !worker) return detach(inv, flags);

  // Workers always emit NDJSON (to their stdout file) and never a TTY feed.
  const json = worker || flags.json;
  const quiet = flags.quiet && !worker;
  const kind = inv.kind;
  const reporter = makeReporter({
    quiet,
    thinking: flags.thinking ?? kind !== 'task',
  });
  let streamedText = '';
  const onEvent = json
    ? (ev) => {
        if (quiet) return;
        if (ev.type === 'stream' && !inv.stream) return;
        process.stdout.write(JSON.stringify(ev) + '\n');
      }
    : (ev) => {
        if (ev.type === 'stream' && ev.kind === 'text_delta' && ev.delta && kind !== 'task') {
          reporter.closeThinking();
          streamedText += ev.delta;
          process.stdout.write(ev.delta);
          return;
        }
        reporter.onEvent(ev);
      };

  // SIGINT/SIGTERM (Ctrl-C, `zcode cancel`) abort cleanly: the engine is
  // told to stop, checks are killed, the session is recorded "cancelled".
  // A second signal exits immediately.
  const controller = new AbortController();
  let signals = 0;
  const onSignal = () => {
    signals++;
    if (signals > 1) process.exit(130);
    controller.abort();
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  let result;
  try {
    result = await execute(inv, { onEvent, signal: controller.signal });
  } catch (err) {
    if (err instanceof ConfigError || err instanceof ExecError) {
      const failed = {
        type: 'result', ok: false, status: 'failed', id: inv.id, kind,
        error: { kind: err.kind || 'config', message: err.message }, issues: [err.message],
      };
      if (json) process.stdout.write(JSON.stringify(failed) + '\n');
      // A detached worker's caller polls the store: record why it never ran
      // (conflicts already record themselves).
      if (worker && err.kind !== 'conflict' && store.readSession(inv.id)) {
        store.writeResult(inv.id, failed);
        store.updateSession(inv.id, { state: 'finished', phase: 'done', status: 'failed', outcome: { status: 'failed', issues: [err.message] } });
      }
      process.stderr.write(`zcode: ${err.message}\n`);
      process.exit(err.exitCode);
    }
    if (err instanceof store.SessionExistsError) usage(err.message);
    throw err;
  }

  const code = exitCodeFor(result);
  if (json) {
    process.stdout.write(JSON.stringify(result) + '\n');
  } else if (kind === 'task') {
    reporter.closeThinking();
    process.stdout.write(formatResult(result, { color: useColor(process.stdout) }));
  } else {
    reporter.closeThinking();
    if (!streamedText.trim()) process.stdout.write(result.response || '');
    process.stdout.write('\n');
    reporter.footer(result);
    if (result.status !== 'completed' || kind === 'agent') {
      process.stderr.write(formatResult(result, { color: useColor(process.stderr) }));
    }
  }
  process.exit(code);
};

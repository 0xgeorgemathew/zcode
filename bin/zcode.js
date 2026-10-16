#!/usr/bin/env node
'use strict';
// zcode — CLI entry: argv parsing + command dispatch. Parsing rejects bad
// input (exit 2) before any engine spawn or session record exists.
const { normalizeModel, unknownModelMessage, normalizeEffort, EFFORT_LEVELS, DEFAULT_MODEL } = require('../lib/models.js');

const USAGE = `usage:
  zcode task [options] <objective…>    execute a task contract, verify it, hand back
  zcode [run] [options] <prompt…>      one-shot turn (prompt via stdin when piped)
  zcode agent [options] <instructions…> turn that MUST dispatch a subagent
  zcode resume <id> [message…]         continue a session (answer, follow-up, retry)
  zcode status [<id>] [--all] [--json] one session in detail, or the 15 most recent (--all: every session)
  zcode wait <id…> [--any] [--json]    block until sessions finish; print handbacks
  zcode result <id> [--full] [--json]  print a finished session's handback (brief by default)
  zcode cancel <id> [--json]           stop a running session
  zcode plan check <file>              validate a plan file (ids, after, cycles, owns, effort)
  zcode plan run <file> [--preflight] [--detach] [--timeout-ms n] [--id name] [--json]
                                       run a DAG of task sessions (see "plan" below)
  zcode plan wait|status <name> [--timeout-ms n] [--json]
                                       one summary line: {type:"plan",name,status,sessions,briefs}
  zcode plan resume <name> [message…] [--session <id>]
                                       resume failed/partial/blocked sessions, restart supervision
  zcode login                          read API key from stdin → credentials
  zcode doctor [--json]                engine + isolation + key report
  zcode skills [install|uninstall] [claude|codex]
                                       install the orchestrator skills (default: status)

session:
  --id <id>             name the session (letters, digits, . _ -); default zc-<random>.
                        An existing id is never re-run: use resume.
  --label <text>        free-form label shown in status
  --detach              start in the background, print the id, exit 0
  --cwd <dir>           workspace (default: current dir)
  --owns <path|glob>    repeatable: paths this session may change (relative to
                        --cwd). Default: the whole workspace. Overlapping
                        ownership with a running session is refused (exit 7)
  --allow-overlap       start despite overlapping ownership

task contract (task only):
  --task <file|->       JSON contract or markdown brief (- = stdin)
  --accept <text>       repeatable acceptance criterion
  --check <command>     repeatable shell check zcode runs after the work
  --touch <path|glob>   repeatable: minimal edits allowed outside --owns; reported
                        as "touched", not a scope violation. Refused (exit 7) if a
                        running session owns a matching path; reserves nothing
  --file <path>         repeatable relevant file to read first (a file also given
                        as --context @file is inlined once, not listed twice)
  --context <text|@f>   repeatable extra context (references, background)
  --decision <text>     repeatable binding decision the orchestrator made (the
                        executor implements it exactly and must not guess others)
  --decisions <@f|text> binding decisions from a file (same list as --decision)
  --preflight           read-only turn: the executor lists the open questions it
                        would otherwise guess (blocked + questions, or completed
                        "no open questions"); no edits, no checks. Then
                        zcode resume <id> "<answers>" executes the task
  --unit "n: goal [owns a,b]"  repeatable: one subagent per unit inside this
                        session; owns must lie within --owns and be disjoint
  --visual <criterion>  repeatable: the executor serves the app on $ZCODE_PORT,
                        screenshots it with Playwright and judges each criterion
  --viewport <WxH>      repeatable viewport for --visual (default 390x844, 1440x900)
  --serve <cmd>         command that serves the app for --visual (honours $ZCODE_PORT)
  --max-repairs <n>     repair turns after failing checks (default 2)
  --check-timeout-ms <n> per-check timeout (default 300000)

plan (zcode plan run <plan.json>):
  plan.json             {cwd?, decisions?, context?, files?, model?, effort?, limits?,
                        sessions:[{id, after?:[ids], label?, ...task contract keys}]}; the
                        top-level decisions/context/files are prepended to every
                        session. A session starts when everything it is "after" has
                        completed; sessions that can run together must own disjoint
                        paths. A session ending non-completed marks its downstream
                        "skipped"; the others continue
  --preflight           plan run: read-only preflight of every session ("<id>.pre"),
                        prints the questions as one brief per session (exit 10 if any)
  --detach              plan run/resume: supervise in a background process
  --id <name>           plan name (default: the file's basename)
  --session <id>        plan resume: only this session

execution:
  --model <id>          glm-5.3 | glm-5.3-flash (+aliases). default: glm-5.3-flash
  --effort <level>      low | high | max for both models (zcode doctor lists the
                        engine's levels per model); an unsupported level exits 2
                        before any spawn. default: max
  --timeout-ms <n>      whole invocation incl. checks/repairs (default 600000;
                        task default 7200000 = 2 h)
  --profile <name>      subagent profile (agent command; default general-purpose)
  --mcp <json|@f>       add MCP servers (repeatable); hermetic by default
  --mcp-inherit         also inherit the desktop's enabled MCP servers
  --no-browser          drop the desktop's playwright MCP server (on by default)
  --mcp-list            print the effective MCP server set as JSON and exit
  --skills <dir>        add skills (repeatable): one skill dir or a root of them
  --no-skills           empty skill set

output:
  --json                NDJSON events on stdout; final line is the compact brief
                        {"type":"result","schema":"zcode.brief/1",…}
  --full                with --json (and result/wait): the full record instead
                        (schema zcode.result/1; result.json on disk is always full)
  --any                 wait: return as soon as the FIRST id finishes
  --quiet               no progress: no stderr feed; with --json only the result line;
                        usage errors are always a single line
  --thinking / --no-thinking   mirror reasoning to stderr (run: on, task: off)
  --stream              task --json: include text/reasoning deltas in the events
  --include-reasoning   full reasoning text in the result
  -p, --prompt <t>      prompt text (alias for positional prompt)
  --session <id>        run: continue a session (zcode id or engine sess_ id)
  --version, --help

exit codes: 0 completed · 2 usage · 3 no key · 4 no engine · 5 failed ·
  6 agent: no subagent · 7 workspace conflict / session busy · 8 partial or
  checks failing · 9 unverified · 10 blocked · 124 timeout · 130 cancelled`;

function fail(code, message) {
  process.stderr.write(`zcode: ${message}\n`);
  process.exit(code);
}

function readFileOrFail(file, flag) {
  try {
    return require('node:fs').readFileSync(file, 'utf8');
  } catch {
    return fail(2, `${flag} file "${file}" could not be read.`);
  }
}

// --mcp accepts inline JSON or @file mapping server names to definitions.
function parseMcpSpec(value) {
  const text = value.startsWith('@') ? readFileOrFail(value.slice(1), '--mcp') : value;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    fail(2, `--mcp spec must be valid JSON mapping server names to definitions: ${err.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail(2, `--mcp spec must be valid JSON mapping server names to definitions, got ${Array.isArray(parsed) ? 'an array' : `a ${typeof parsed}`}.`);
  }
  for (const [name, def] of Object.entries(parsed)) {
    if (!def || typeof def !== 'object' || Array.isArray(def)) {
      fail(2, `--mcp server "${name}" must be an object (e.g. {"type":"stdio","command":...,"args":[...]}).`);
    }
  }
  return parsed;
}

const COMMANDS = new Set(['run', 'task', 'agent', 'resume', 'status', 'list', 'wait', 'cancel', 'login', 'doctor', 'skills', 'result', 'plan', '__plan', '__exec']);
const TASK_ONLY = new Set(['task', 'accept', 'check', 'file', 'context', 'touch', 'maxRepairs', 'checkTimeoutMs', 'decisions', 'units', 'visual', 'viewports', 'serve', 'preflight']);
const FULL_COMMANDS = new Set(['run', 'task', 'agent', 'resume', 'wait', 'result', '__exec']);
const START_ONLY = new Set(['id', 'label', 'owns', 'touch', 'preflight', 'allowOverlap', 'mcpSpecs', 'mcpInherit', 'noBrowser', 'skillsDirs', 'noSkills', 'profile', 'cwd']);

function parseArgv(argv) {
  const out = {
    command: 'run',
    prompts: [],
    given: new Set(),
    flags: {
      model: DEFAULT_MODEL,
      effort: 'max',
      cwd: process.cwd(),
      json: false,
      fresh: false,
      timeoutMs: undefined,
      profile: 'general-purpose',
      prompt: undefined,
      session: undefined,
      id: undefined,
      label: undefined,
      detach: false,
      task: undefined,
      accept: [],
      check: [],
      file: [],
      context: [],
      owns: [],
      touch: [],
      decisions: [],
      units: [],
      visual: [],
      viewports: [],
      serve: undefined,
      preflight: false,
      allowOverlap: false,
      maxRepairs: undefined,
      checkTimeoutMs: undefined,
      mcpSpecs: [],
      mcpInherit: false,
      noBrowser: false,
      mcpList: false,
      skillsDirs: [],
      noSkills: false,
      includeReasoning: false,
      quiet: false,
      thinking: undefined,
      stream: false,
      full: false,
      any: false,
      all: false,
    },
  };
  const valueFlags = new Map([
    ['--model', 'model'], ['--effort', 'effort'], ['--cwd', 'cwd'], ['--profile', 'profile'],
    ['--timeout-ms', 'timeoutMs'], ['-p', 'prompt'], ['--prompt', 'prompt'], ['--session', 'session'],
    ['--id', 'id'], ['--label', 'label'], ['--task', 'task'], ['--max-repairs', 'maxRepairs'],
    ['--check-timeout-ms', 'checkTimeoutMs'], ['--serve', 'serve'],
  ]);
  const listFlags = new Map([
    ['--mcp', 'mcpSpecs'], ['--skills', 'skillsDirs'], ['--accept', 'accept'], ['--check', 'check'],
    ['--file', 'file'], ['--context', 'context'], ['--owns', 'owns'], ['--touch', 'touch'],
    ['--decision', 'decisions'], ['--decisions', 'decisions'], ['--unit', 'units'], ['--visual', 'visual'],
    ['--viewport', 'viewports'],
  ]);
  const boolFlags = new Map([
    ['--json', ['json', true]], ['--fresh', ['fresh', true]], ['--mcp-inherit', ['mcpInherit', true]],
    ['--mcp-list', ['mcpList', true]], ['--no-skills', ['noSkills', true]], ['--no-browser', ['noBrowser', true]],
    ['--include-reasoning', ['includeReasoning', true]], ['--quiet', ['quiet', true]],
    ['--detach', ['detach', true]], ['--allow-overlap', ['allowOverlap', true]],
    ['--thinking', ['thinking', true]], ['--no-thinking', ['thinking', false]], ['--stream', ['stream', true]],
    ['--full', ['full', true]], ['--any', ['any', true]], ['--all', ['all', true]], ['--preflight', ['preflight', true]],
  ]);
  const numeric = (flag, value, { min = 1 } = {}) => {
    const n = Number(value);
    if (!Number.isFinite(n) || n < min) fail(2, `${flag} must be a number >= ${min}, got "${value}".`);
    return n;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (valueFlags.has(arg) || listFlags.has(arg)) {
      const key = valueFlags.get(arg) || listFlags.get(arg);
      const value = argv[++i];
      if (value === undefined) fail(2, `option ${arg} requires a value.`);
      out.given.add(key);
      if (key === 'timeoutMs' || key === 'checkTimeoutMs') out.flags[key] = numeric(arg, value);
      else if (key === 'maxRepairs') out.flags[key] = numeric(arg, value, { min: 0 });
      else if (key === 'mcpSpecs') out.flags.mcpSpecs.push(parseMcpSpec(value));
      else if (key === 'skillsDirs') {
        if (!isDirectory(value)) fail(2, `--skills requires an existing directory, got "${value}".`);
        out.flags.skillsDirs.push(value);
      } else if (listFlags.has(arg)) out.flags[key].push(value);
      else if (!value.trim()) fail(2, `${arg} requires a non-empty value.`);
      else out.flags[key] = value.trim();
      continue;
    }
    if (boolFlags.has(arg)) {
      const [key, v] = boolFlags.get(arg);
      out.given.add(key);
      out.flags[key] = v;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      // Scan the rest of argv for the command: `zcode --help task` works too.
      let command = out.commandSet ? out.command : null;
      if (!command) for (const a of argv) if (COMMANDS.has(a) && !a.startsWith('__')) { command = a === 'list' ? 'status' : a; break; }
      const text = command && require('../lib/help.js').commandHelp(command);
      process.stdout.write((text || USAGE) + '\n');
      process.exit(0);
    }
    if (arg === '--version') {
      process.stdout.write(require('../package.json').version + '\n');
      process.exit(0);
    }
    if (arg === '--') {
      out.prompts.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith('--') && arg.length > 2) {
      const hint = suggestFlag(arg, [...valueFlags.keys(), ...listFlags.keys(), ...boolFlags.keys()]);
      fail(2, `unknown flag ${arg} (${hint ? `did you mean ${hint}?` : 'see zcode --help'})`);
    }
    if (out.prompts.length === 0 && out.command === 'run' && !out.commandSet && COMMANDS.has(arg)) {
      out.command = arg === 'list' ? 'status' : arg;
      out.commandSet = true;
      continue;
    }
    out.prompts.push(arg);
  }

  const cmd = out.command;
  if (out.flags.prompt !== undefined) out.prompts.unshift(out.flags.prompt);
  if (cmd !== 'task') {
    for (const key of TASK_ONLY) {
      if (cmd === 'plan' && key === 'preflight') continue;
      if (out.given.has(key) && !(cmd === 'resume' && (key === 'maxRepairs' || key === 'checkTimeoutMs'))) {
        fail(2, `--${flagName(key)} is only valid with "zcode task".`);
      }
    }
  }
  if (cmd === 'plan' || cmd === '__plan') {
    for (const key of ['label', 'owns', 'touch', 'allowOverlap', 'model', 'effort', 'profile']) {
      if (out.given.has(key)) fail(2, `--${flagName(key)} is not valid with "zcode plan"; set it in the plan file.`);
    }
  }
  if (cmd === 'resume' || cmd === '__exec') {
    for (const key of START_ONLY) {
      if (out.given.has(key)) fail(2, `--${flagName(key)} cannot change on resume; it is fixed when the session starts.`);
    }
  }
  if (out.given.has('all') && cmd !== 'status') fail(2, '--all is only valid with "zcode status".');
  if (out.given.has('any') && cmd !== 'wait') fail(2, '--any is only valid with "zcode wait".');
  if (out.given.has('full') && !FULL_COMMANDS.has(cmd)) fail(2, `--full is not valid with "zcode ${cmd}".`);
  if (out.given.has('session') && cmd !== 'run' && cmd !== 'plan') fail(2, '--session is only valid with "zcode run"; use "zcode resume <id>".');
  if (out.given.has('id') && !require('../lib/store.js').validId(out.flags.id)) {
    fail(2, `--id "${out.flags.id}" must be 1-64 chars of letters, digits, ".", "_" or "-", starting with a letter or digit.`);
  }
  if (!isDirectory(out.flags.cwd)) fail(2, `--cwd must be an existing directory, got "${out.flags.cwd}".`);

  const model = normalizeModel(out.flags.model);
  if (!model) fail(2, unknownModelMessage(out.flags.model));
  out.flags.model = model;
  const effort = normalizeEffort(out.flags.effort);
  if (!effort) fail(2, `unknown effort "${out.flags.effort}". --effort accepts ${EFFORT_LEVELS.join(' | ')}.`);
  out.flags.effort = effort;
  return out;
}

// Closest known flag by edit distance (<= 2), or null.
function suggestFlag(arg, known) {
  const dist = (a, b) => {
    const row = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      let prev = row[0];
      row[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const tmp = row[j];
        row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
        prev = tmp;
      }
    }
    return row[b.length];
  };
  let best = null;
  let bestD = Infinity;
  for (const k of known) {
    if (!k.startsWith('--')) continue;
    const d = dist(arg, k);
    if (d < bestD) { best = k; bestD = d; }
  }
  return best && bestD <= 2 ? best : null;
}

function flagName(key) {
  return key.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`).replace(/^mcp-specs$/, 'mcp').replace(/^skills-dirs$/, 'skills')
    .replace(/^(unit|viewport)s$/, '$1');
}

function isDirectory(p) {
  try {
    return require('node:fs').statSync(p).isDirectory();
  } catch {
    return false;
  }
}

async function main() {
  const parsed = parseArgv(process.argv.slice(2));
  if (parsed.flags.mcpList) return require('../lib/commands/mcp-list.js')(parsed);
  switch (parsed.command) {
    case 'run':
    case 'task':
    case 'agent':
    case 'resume':
    case '__exec':
      return require('../lib/commands/exec.js')(parsed);
    case 'plan':
    case '__plan':
      return require('../lib/commands/plan.js')(parsed);
    case 'status':
    case 'wait':
    case 'result':
    case 'cancel':
      return require('../lib/commands/sessions.js')(parsed);
    case 'login':
      return require('../lib/commands/login.js')(parsed);
    case 'doctor':
      return require('../lib/commands/doctor.js')(parsed);
    case 'skills':
      return require('../lib/commands/skills.js')(parsed);
    default:
      return fail(2, `unknown command "${parsed.command}" (see zcode --help).`);
  }
}

// Exported before main() runs: the plan supervisor reuses parseArgv.
module.exports = { parseArgv, USAGE };

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`zcode: internal error: ${err && err.stack ? err.stack : err}\n`);
    process.exit(1);
  });
}


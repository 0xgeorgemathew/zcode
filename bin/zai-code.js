#!/usr/bin/env node
'use strict';
// zai-code — CLI entry: argv parsing + command dispatch (DESIGN §10).
const { normalizeModel, unknownModelMessage, normalizeEffort, EFFORT_LEVELS, DEFAULT_MODEL } = require('../lib/models.js');

const EXIT = {
  OK: 0,
  INTERNAL: 1,
  USAGE: 2,
  NO_KEY: 3,
  NO_ENGINE: 4,
  TURN_FAILED: 5,
  NO_SUBAGENT: 6,
  TIMEOUT: 124,
};

const USAGE = `usage: zai-code [options] [prompt…]        one-shot turn (prompt via stdin when piped)
       zai-code agent [--profile <name>] <instructions…>
                                            turn that MUST dispatch a subagent
       zai-code login                       read API key from stdin → credentials
       zai-code doctor [--json] [--fresh]   engine + isolation + key report

options:
  --model <id>      glm-5.3 | glm-5.3-flash (+aliases). default: glm-5.3-flash
  --effort <level>  low | medium | high | xhigh | max. default: max
  --cwd <dir>       workspace for the session (default: process.cwd())
  --profile <name>  subagent profile (agent command; default: general-purpose)
  --session <id>    continue a previous session (sessionId from a prior result)
  --mcp <json|@f>   add MCP servers (repeatable). JSON maps names to defs:
                    {"name":{"type":"stdio","command","args","env"}} or
                    {"name":{"type":"http","url","headers"}}; @file reads a file.
                    Hermetic default: only these run (deterministic, fast)
  --mcp-inherit     also inherit the desktop's enabled MCP servers
  --mcp-list        print the effective MCP server set as JSON and exit
  --skills <dir>    add skills (repeatable): one skill dir (has SKILL.md) or a
                    root of <name>/SKILL.md dirs. project <cwd>/.zcode/skills
                    is picked up by the engine without any flag
  --no-skills       run with an empty skill set (nothing inherited, nothing injected)
  --include-reasoning  put the full reasoning text in the final JSON result
  --quiet           do not mirror reasoning to stderr while running
  --json            NDJSON events on stdout; final line {"type":"result",…}
                    (stream events include reasoning_delta = thinking)
  --timeout-ms <n>  default 600000
  --fresh           rebuild the scratch HOME first
  -p, --prompt <t>  prompt text (alias for positional prompt)
  --version, --help`;

function fail(code, message) {
  process.stderr.write(`zai-code: ${message}\n`);
  process.exit(code);
}

function isDirectory(p) {
  try {
    return require('node:fs').statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// --mcp accepts inline JSON or @file; the JSON must map server names to
// definition objects ({type:"stdio"|"http"|"sse", ...} per the engine's
// config schema). Fails (exit 2) before any engine spawn.
function parseMcpSpec(value) {
  let text = value;
  if (value.startsWith('@')) {
    try {
      text = require('node:fs').readFileSync(value.slice(1), 'utf8');
    } catch {
      fail(EXIT.USAGE, `--mcp file "${value.slice(1)}" could not be read.`);
    }
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    fail(EXIT.USAGE, `--mcp spec must be valid JSON mapping server names to definitions: ${err.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail(EXIT.USAGE, `--mcp spec must be valid JSON mapping server names to definitions, got ${Array.isArray(parsed) ? 'an array' : `a ${typeof parsed}`}.`);
  }
  for (const [name, def] of Object.entries(parsed)) {
    if (!def || typeof def !== 'object' || Array.isArray(def)) {
      fail(EXIT.USAGE, `--mcp server "${name}" must be an object (e.g. {"type":"stdio","command":...,"args":[...]}).`);
    }
  }
  return parsed;
}

// Parses argv (without node/script) into {command, prompts, flags}.
// Exits 2 on usage errors. Rejection happens here, before any engine spawn.
function parseArgv(argv) {
  const out = {
    command: 'run',
    prompts: [],
    flags: {
      model: DEFAULT_MODEL,
      effort: 'max',
      cwd: process.cwd(),
      json: false,
      fresh: false,
      timeoutMs: 600000,
      profile: 'general-purpose',
      prompt: undefined,
      session: undefined,
      mcpSpecs: [],
      mcpInherit: false,
      mcpList: false,
      skillsDirs: [],
      noSkills: false,
      includeReasoning: false,
      quiet: false,
    },
  };
  const valueFlags = new Map([
    ['--model', 'model'],
    ['--effort', 'effort'],
    ['--cwd', 'cwd'],
    ['--profile', 'profile'],
    ['--timeout-ms', 'timeoutMs'],
    ['-p', 'prompt'],
    ['--prompt', 'prompt'],
    ['--session', 'session'],
  ]);
  const listFlags = new Map([
    ['--mcp', 'mcpSpecs'],
    ['--skills', 'skillsDirs'],
  ]);
  const boolFlags = new Map([
    ['--json', 'json'],
    ['--fresh', 'fresh'],
    ['--mcp-inherit', 'mcpInherit'],
    ['--mcp-list', 'mcpList'],
    ['--no-skills', 'noSkills'],
    ['--include-reasoning', 'includeReasoning'],
    ['--quiet', 'quiet'],
  ]);
  const commands = new Set(['run', 'agent', 'login', 'doctor']);

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (valueFlags.has(arg) || boolFlags.has(arg) || listFlags.has(arg)) {
      let key;
      if (valueFlags.has(arg)) {
        key = valueFlags.get(arg);
        const value = argv[++i];
        if (value === undefined) fail(EXIT.USAGE, `option ${arg} requires a value.\n${USAGE}`);
        if (key === 'timeoutMs') {
          const n = Number(value);
          if (!Number.isFinite(n) || n <= 0) fail(EXIT.USAGE, `--timeout-ms must be a positive number, got "${value}".`);
          out.flags[key] = n;
        } else if (key === 'session') {
          if (!value.trim()) fail(EXIT.USAGE, '--session requires a session id.');
          out.flags[key] = value.trim();
        } else {
          out.flags[key] = value;
        }
      } else if (listFlags.has(arg)) {
        key = listFlags.get(arg);
        const value = argv[++i];
        if (value === undefined) fail(EXIT.USAGE, `option ${arg} requires a value.\n${USAGE}`);
        if (key === 'mcpSpecs') {
          out.flags.mcpSpecs.push(parseMcpSpec(value, arg));
        } else {
          if (!isDirectory(value)) fail(EXIT.USAGE, `--skills requires an existing directory, got "${value}".`);
          out.flags.skillsDirs.push(value);
        }
      } else {
        key = boolFlags.get(arg);
        out.flags[key] = true;
      }
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      process.stdout.write(USAGE + '\n');
      process.exit(EXIT.OK);
    }
    if (arg === '--version') {
      process.stdout.write(require('../package.json').version + '\n');
      process.exit(EXIT.OK);
    }
    if (arg === '--') {
      out.prompts.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith('--') && arg.length > 2) {
      fail(EXIT.USAGE, `unknown option "${arg}".\n${USAGE}`);
    }
    if (out.prompts.length === 0 && commands.has(arg)) {
      out.command = arg;
      continue;
    }
    out.prompts.push(arg);
  }

  if (out.command === 'run' && out.flags.prompt !== undefined) {
    out.prompts.unshift(out.flags.prompt);
  }

  const model = normalizeModel(out.flags.model);
  if (!model) fail(EXIT.USAGE, unknownModelMessage(out.flags.model));
  out.flags.model = model;

  const effort = normalizeEffort(out.flags.effort);
  if (!effort) {
    fail(
      EXIT.USAGE,
      `unknown effort "${out.flags.effort}". --effort accepts ${EFFORT_LEVELS.join(' | ')}.`
    );
  }
  out.flags.effort = effort;
  return out;
}

async function main() {
  const parsed = parseArgv(process.argv.slice(2));
  const { command, flags } = parsed;
  if (flags.mcpList) {
    return require('../lib/commands/mcp-list.js')(parsed);
  }
  const run = require('../lib/commands/run.js');
  switch (command) {
    case 'run':
      return run(parsed);
    case 'agent':
      return require('../lib/commands/agent.js')(parsed);
    case 'login':
      return require('../lib/commands/login.js')(parsed);
    case 'doctor':
      return require('../lib/commands/doctor.js')(parsed);
    default:
      fail(EXIT.USAGE, `unknown command "${command}".\n${USAGE}`);
  }
}

main().catch((err) => {
  process.stderr.write(`zai-code: internal error: ${err && err.stack ? err.stack : err}\n`);
  process.exit(EXIT.INTERNAL);
});

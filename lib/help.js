'use strict';
// Per-command help: `zcode <command> --help` prints the command's usage and
// only the flags that apply to it (each text <= 2000 bytes). The full text
// (bin/zcode.js USAGE) is for `zcode --help` with no command.
const SESSION = `  --id <id>        name the session (existing id is never re-run: use resume)
  --label <text>   free-form label shown in status
  --detach         start in the background, print the id, exit 0
  --cwd <dir>      workspace (default: current dir)
  --owns <path>    repeatable: paths this session may change (default: whole workspace)
  --allow-overlap  start despite overlapping ownership`;
const EXEC = `  --model <id>     glm-5.3 | glm-5.3-flash (default glm-5.3-flash)
  --effort <lvl>   low | high | max (default max)
  --mcp <json|@f>  add MCP servers (repeatable)   --mcp-inherit   --no-browser
  --skills <dir>   add skills (repeatable)        --no-skills
  --json           NDJSON events; last line is the compact brief (--full: whole record)
  --quiet          no progress feed; with --json only the result line`;

const HELP = {
  task: `usage: zcode task [options] <objective...>
Execute a task contract, verify it with zcode-run checks, hand back.

contract:
  --task <file|->       JSON contract or markdown brief (- = stdin)
  --accept <text>       repeatable acceptance criterion
  --check <command>     repeatable shell check zcode runs after the work
  --file <path>         repeatable file to read first
  --context <text|@f>   repeatable context   --decision <text> / --decisions <@f>
  --touch <path>        repeatable minimal edits allowed outside --owns
  --unit "n: goal [owns a,b]"  repeatable subagent unit
  --visual <criterion>  repeatable   --viewport <WxH>   --serve <cmd>
  --preflight           read-only: list open questions, no edits
  --max-repairs <n>     default 2     --check-timeout-ms <n>  default 300000
session:
${SESSION}
  --timeout-ms <n>      whole invocation (default 7200000 = 2 h)
${EXEC}
Full reference: zcode --help`,
  run: `usage: zcode [run] [options] <prompt...>
One-shot turn (prompt via stdin when piped).
  --session <id>   continue a session
  --timeout-ms <n> default 600000
  --thinking | --no-thinking   mirror reasoning to stderr
${SESSION}
${EXEC}
Full reference: zcode --help`,
  agent: `usage: zcode agent [options] <instructions...>
Turn that MUST dispatch a subagent.
  --profile <name> subagent profile (default general-purpose)
  --timeout-ms <n> default 600000
${SESSION}
${EXEC}
Full reference: zcode --help`,
  resume: `usage: zcode resume <id> [message...]
Continue a session: answer questions, follow up, or retry after a timeout.
Pass "-" as the message to read it from stdin.
  --timeout-ms <n>  --max-repairs <n>  --check-timeout-ms <n>
  --model <id>  --effort <lvl>
  --json  --full  --quiet  --include-reasoning
Start-time flags (--id, --owns, --cwd, ...) cannot change on resume.`,
  status: `usage: zcode status [<id>] [--all] [--json]
One session in detail, or the 15 most recent (--all: every session).
  --json   machine-readable list or detail`,
  wait: `usage: zcode wait <id...> [--any] [--json] [--full] [--timeout-ms n]
Block until sessions finish; print each handback.
  --any            return when the FIRST id finishes
  --timeout-ms <n> one line per pending session, exit 124
  --json           briefs   --full  full records`,
  watch: `usage: zcode watch [<id>… | --plan <name>] [--stall-min n]
Live view of sessions, no model tokens. One line each:
  id  state phase[ n/m]  elapsed  last: <tool> <age> ago  req <n>  sub <running>
STALLED? is appended when a running session has had no engine event for
--stall-min minutes (default 8). Nothing is done automatically.
  <id…>        the sessions to watch
  --plan name  every session of a plan
  (no args)    live sessions and those finished in the last 10 minutes
TTY: redraws every 2 s. Piped: a line is printed only when a session changes.
Exits 0 when every watched session has finished; Ctrl-C exits 0.`,
  result: `usage: zcode result <id> [--json] [--full]
Print a finished session's handback without waiting (exit 7 if running).
  --json  compact brief   --full  the whole record`,
  cancel: `usage: zcode cancel <id> [--json]
Stop a running session (SIGTERM, SIGKILL after 15 s). No-op when finished.`,
  plan: `usage: zcode plan <subcommand>
  zcode plan check <file>              validate (ids, after, cycles, owns, effort)
  zcode plan run <file> [--preflight] [--detach] [--timeout-ms n] [--id name] [--json]
  zcode plan wait|status <name> [--timeout-ms n] [--json]
  zcode plan resume <name> [message...] [--session <id>]
plan file: {cwd?, decisions?, context?, files?, model?, effort?, limits?,
  sessions:[{id, after?:[ids], label?, ...task contract keys}]}
  top-level decisions/context/files are prepended to every session; limits
  ({timeoutMs,maxRepairs,checkTimeoutMs}) default every session; "@file"
  resolves next to the plan file, then against its cwd.
  --preflight  read-only preflight of every session (sessions with "after"
               are told to assume their prerequisites)
  --detach     supervise in a background process
  --id <name>  plan name (default: file basename)
  --cwd <dir>  workspace override
Exit: 0 completed, 10 blocked, 8 partial/failed, 124 timeout.`,
  login: `usage: zcode login
Read the API key from stdin and store it in the credentials file.`,
  doctor: `usage: zcode doctor [--json]
Engine, isolation and key report.`,
  skills: `usage: zcode skills [install|uninstall] [claude|codex]
Install the orchestrator skills (default: show status).`,
};

function commandHelp(command) {
  return HELP[command] || null;
}

module.exports = { commandHelp };

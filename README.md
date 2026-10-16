<p align="center">
  <img src="https://raw.githubusercontent.com/0xgeorgemathew/zcode/main/docs/assets/hero.svg" alt="A zcode work order: the contract on the left, the handback with changed files, a passing check and a COMPLETED stamp on the right" width="960">
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@0xgeorgemathew/zcode"><img src="https://img.shields.io/npm/v/@0xgeorgemathew/zcode.svg?color=1C3F95&label=npm" alt="npm version"></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A520-1C3F95" alt="node 20 or later">
  <img src="https://img.shields.io/badge/dependencies-0-1C3F95" alt="zero dependencies">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-1C3F95" alt="MIT license"></a>
</p>

zcode is a command-line executor for orchestrator agents. Claude Code, Codex, or any agent with a shell hands it a task contract. zcode implements the task with GLM-5.3-Flash, runs your checks itself, and returns a handback that lists the changed files, the check results, and anything it could not verify.

The orchestrator keeps product decisions, design direction, and coordination. zcode works only inside the scope it is given.

<table>
<tr><td><b>Contract in</b></td><td>Objective, scope, constraints, binding design decisions, acceptance criteria, owned paths and checks. Only the objective is required.</td></tr>
<tr><td><b>Checks run by zcode</b></td><td>zcode runs each <code>--check</code> after the work. A failing check sends its output back to the model for up to 2 repair turns.</td></tr>
<tr><td><b>Status from evidence</b></td><td><code>completed</code> requires passing checks and no edits outside <code>--owns</code>. The model's own report is kept as a claim.</td></tr>
<tr><td><b>Sessions</b></td><td>Stable ids, <code>--detach</code>, <code>status</code>, <code>wait</code>, <code>resume</code>, <code>cancel</code>. A session whose process died shows as interrupted and can be resumed.</td></tr>
<tr><td><b>Parallel work</b></td><td>Two sessions with overlapping <code>--owns</code> in one repo are refused with exit 7.</td></tr>
<tr><td><b>Output</b></td><td>One <code>zcode.result/1</code> JSON line with <code>--json</code>. No colour codes when stdout is not a terminal.</td></tr>
</table>

&nbsp;

## Quick start

```sh
npm install -g @0xgeorgemathew/zcode
echo "$ZAI_API_KEY" | zcode login    # stores your Z.AI key with mode 600; zcode never prints it
zcode doctor                         # checks the engine, isolation and key

zcode task --check "npm test" "Fix the off-by-one in src/paginate.ts"
```

The CLI needs node 20 or later. The engine child runs best on node 26. zcode also needs the ZCode engine, which today ships inside the ZCode desktop app; zcode finds it automatically.

Skills that teach Claude Code and Codex to delegate to zcode are in [`skills/`](skills/README.md).

&nbsp;

## Models and effort

Every command runs on GLM-5.3-Flash at effort `max` unless you pass a flag.

| setting | flag | values | default |
|---|---|---|---|
| model | `--model` | `glm-5.3-flash` (aliases `flash`, `5.3-flash`, `53f`), `glm-5.3` (aliases `5.3`, `53`) | `glm-5.3-flash` |
| effort | `--effort` | `low`, `medium`, `high`, `xhigh`, `max` | `max` |

```sh
zcode task "..."                                   # GLM-5.3-Flash, effort max
zcode task --effort high "..."                     # Flash with less reasoning
zcode task --model glm-5.3 "..."                   # GLM-5.3, effort max
zcode task --model glm-5.3 --effort medium "..."   # GLM-5.3, effort medium
```

A task contract can set `"model"` and `"effort"`. Flags override the contract. A resumed session keeps its original model and effort unless you pass the flags again.

&nbsp;

## Hand off a task

```sh
zcode task --cwd ./site --id page-1 \
  --owns src/pages/pricing/ \
  --check "npm run build" --check "npm test -- pricing" \
  --accept "Three plan cards, the middle one highlighted" \
  --context @design/pricing.md \
  "Implement the pricing page from the supplied design notes"
```

zcode turns this into an execution contract and runs a fresh engine session in yolo mode, with `--cwd` as the blast radius. The model may split the work across subagents. When it finishes, **zcode runs the checks itself**. If a check fails, zcode feeds the failure output back for a bounded number of repair turns (`--max-repairs`, default 2), then reports:

```text
✓ completed  page-1  142.3s
  Pricing page with three plan cards; middle card highlighted per design notes.
changed  3 files
  A src/pages/pricing/index.tsx
  A src/pages/pricing/PlanCard.tsx
  M src/pages/pricing/styles.css
checks   2/2 passed  ·  1 repair turn
  ✓ npm run build
  ✓ npm test -- pricing
not verified
  - prose acceptance criteria are confirmed only by the executor's own report
```

That block is the format of the summary printed to stdout. The live feed (session header, phases, tools, subagents, check results) goes to stderr. With `--json` you get the same data as one machine-readable result line.

For small work, the objective alone is enough: `zcode task "Fix the typo in the README heading"`.

### The contract

Flags cover the common fields. For richer handoffs, pass `--task contract.json`, `--task brief.md`, or `--task -` to read stdin. Only `objective` is required; unknown keys are rejected so a typo never silently drops a requirement.

```json
{
  "objective": "Implement page 2 (Team) per the design spec",
  "scope": ["Team page route and its components"],
  "constraints": ["No new dependencies", "Keep existing routing untouched"],
  "design": ["Grid of 3 columns ≥1024px, 1 column below", "Use tokens from src/theme.ts only"],
  "acceptance": ["Every member card shows name, role, avatar"],
  "checks": ["npm run build", "npm test -- team"],
  "files": ["src/theme.ts", "src/pages/home/index.tsx"],
  "references": ["design/team.png described in design/team.md"],
  "context": ["Copy lives in content/team.json"],
  "owns": ["src/pages/team/**", "content/team.json"],
  "limits": { "timeoutMs": 1800000, "maxRepairs": 2, "checkTimeoutMs": 300000 },
  "model": "glm-5.3",
  "effort": "high"
}
```

`design` entries are presented to the model as binding decisions it must implement, not revisit. If the model hits a consequential product or design question the contract does not answer, it reports `blocked` with its questions instead of guessing.

### Status: what a result means

| status | meaning | exit |
|---|---|---|
| `completed` | zcode's own checks ran and passed, the executor reports done, no unmet criteria, nothing changed outside `--owns` | 0 |
| `unverified` | executor reports done, but no checks were declared (or no usable handback), so completion is self-reported | 9 |
| `partial` | work remains: executor says partial, a criterion is unmet, or files changed outside the owned scope | 8 |
| `blocked` | needs the orchestrator: `questions` lists what is missing | 10 |
| `failed` | checks still failing after the repair budget (`error.kind: checks_failed`, exit 8), engine/turn error (5), or timeout (124) | 5 / 8 / 124 |
| `cancelled` | stopped by `zcode cancel`, Ctrl-C, or SIGTERM | 130 |

A model claiming success is never enough on its own. A subagent ending `success` only means it returned. The handback block the model writes is reported as `handback` (a claim), and the status is derived from what zcode observed. `notVerified` lists anything zcode could not check itself.

&nbsp;

## Sessions

Every invocation gets a session: `--id page-1`, or a generated `zc-xxxxxxxx`. Each session has its own engine HOME (`~/.zcode-cli/sessions/<id>/home`), so conversation state, engine database, MCP servers, and skills never leak between sessions. An existing id is never re-run, so retrying a start you lost track of fails fast instead of doing the work twice. Use `status` to check on it, or `resume` to continue it.

```sh
zcode task --detach --id page-1 --owns src/pages/home/ --check "npm run build" "Build page 1"
zcode task --detach --id page-2 --owns src/pages/team/ --check "npm run build" "Build page 2"
zcode status                 # all sessions: id, state/status, kind, updated, label
zcode status page-1 --json   # one session: state, phase, activity, recent events, result
zcode wait page-1 page-2     # block until both finish; print each handback
zcode resume page-2 "Use the 2-column variant below 1024px."   # answer / follow up / retry
zcode cancel page-1          # stop the turn and any running check; recorded as cancelled
```

- **Lifecycle.** A session is `queued`, then `running`, then `finished` with a status. If the process that owned a running session dies, the session shows as `interrupted`, which can be resumed.
- **Resume** sends your message into the same engine conversation. For task sessions, the model is told that earlier work is already applied to the workspace, and zcode re-runs the checks and repairs and produces a fresh handback. A resume with no message (task sessions) means "continue from where you stopped".
- **Never automatically re-sent.** zcode retries only engine start-up, which happens before anything reaches the model. A prompt that was delivered is never re-sent automatically. Continuing is always an explicit `resume`.
- **Detached sessions** write their NDJSON to `~/.zcode-cli/sessions/<id>/stdout.ndjson` and diagnostics to `stderr.log`. The handback lands in `result.json`. You never need to read these files: `status` and `wait` print everything.

### Concurrency and ownership

`--owns` declares what a session may change: a path owns its subtree, and globs are supported. Patterns are relative to `--cwd`. A session without `--owns` owns the whole workspace, which is right for a one-off task in its own checkout.

- Starting a session whose ownership **overlaps a running session in the same workspace** is refused with exit 7, unless `--allow-overlap` is passed. The workspace is the git toplevel, so sibling directories of one repo count as one workspace. Disjoint owners (`src/pages/home/` vs `src/pages/team/`) run side by side.
- After the work, zcode diffs the workspace and reports each changed file. Changes outside the session's ownership are listed in `scopeViolations`, and for task sessions they make the result `partial`. Files that fall in a concurrent session's ownership are attributed to that session, not counted against this one.
- For overlapping or risky parallel work, give each session its own git worktree via `--cwd`.
- `ZAI_CODE_MAX_ACTIVE` (default 8) is a soft machine-wide cap. Sessions beyond it wait in `queued`.

&nbsp;

## One-shot turns and subagent dispatch

`zcode` with a prompt (or `zcode run`) is a plain turn. The answer streams to stdout, and thinking is mirrored to stderr as `│ ` lines.

```sh
zcode "What is 17*23? Reply with only the number."
zcode --model glm-5.3 --effort high "Draft a commit message for the staged diff"
echo "$PROMPT" | zcode
```

`zcode agent "<instructions>"` forces a dispatch through the engine's Agent tool. It is verified from `session/subagents`: exit 6 if no subagent ran or any ended in a status other than `success`. `--profile` picks the subagent profile (default `general-purpose`).

Inside `zcode task`, subagents are optional. The executor decides when to use them, gives each a bounded scope and file ownership, and must verify the integrated result.

&nbsp;

## Machine interface

`--json`: stdout carries NDJSON events, then exactly one final `{"type":"result",…}` line. With `--quiet`, the result line is the only output. For task sessions, text/reasoning deltas are left out of the events unless you pass `--stream`, so an orchestrator reading the output pays only for lifecycle events.

```json
{"type":"result","schema":"zcode.result/1","ok":true,"status":"completed","id":"page-1","kind":"task",
 "summary":"…","response":"…executor report…","issues":[],"questions":[],"unresolved":[],"notVerified":[],
 "changes":{"tracking":"git","files":[{"path":"src/pages/home/index.tsx","change":"added","owned":true}]},
 "scopeViolations":[],"checks":[{"command":"npm run build","ok":true,"exitCode":0,"timedOut":false,"durationMs":8123,"output":"…tail…"}],
 "checksPassed":true,"repairs":0,"handback":{"status":"done","summary":"…","changes":[],"checks":[],"criteria":[],"unresolved":[],"questions":[],"notes":""},
 "subagents":[{"agentId":"agent_…","profileId":"general-purpose","status":"success","summary":"…","durationMs":59765}],
 "error":null,"cwd":"/abs/site","workspaceRoot":"/abs/site","owns":["src/pages/home/"],"sessionId":"sess_…","resumed":false,"turns":1,
 "model":"GLM-5.3-Flash","effort":"max","mode":"yolo","usage":{"inputTokens":19608,"outputTokens":3120},
 "toolCalls":14,"durationMs":142301,"files":{"session":"…/sessions/page-1","result":"…/result.json","events":"…/events.ndjson"}}
```

`model` and `effort` are engine-reported (from the engine's `model_request_started` event), not echoes. `sessionId` is the engine's session id; `id` is the zcode session id you pass to `status`, `wait`, `resume`, and `cancel`. A run that fails still ends with a parseable result line.

| event | meaning |
|---|---|
| `{"type":"session","id","kind","cwd","owns","checks","model","effort","resumed"}` | which session is active, and its scope |
| `{"type":"phase","phase":"starting\|executing\|reporting\|checking\|repairing\|queued"}` | what is running |
| `{"type":"tool","name":"Edit","phase":"started"}` | tool lifecycle (`scheduled`, `started`, `result`, `error`) |
| `{"type":"subagent","phase":"started\|returned\|error"}` | subagent activity |
| `{"type":"check","phase":"finished","command","ok","exitCode","durationMs"}` | zcode-run verification |
| `{"type":"mcp","name","status"}` · `{"type":"retry",…}` · `{"type":"model_request_started",…}` | MCP settling, start-up retry, engine model evidence |
| `{"type":"stream","kind":"text_delta\|reasoning_delta","delta"}` | live text (run/agent; task with `--stream`) |

`zcode status <id> --json` returns `{"type":"status", state, status, phase, pid, live, activity, recent:[…], result?}`. `zcode wait --json` prints one result line per session as each finishes.

&nbsp;

## Options

| option | applies to | default | notes |
|---|---|---|---|
| `--id`, `--label` | run, task, agent | `zc-<random>` | session identity |
| `--detach` | run, task, agent, resume | off | background worker; prints the id |
| `--cwd` | run, task, agent | current dir | the workspace and blast radius |
| `--owns` | run, task, agent | whole workspace | repeatable path or glob |
| `--allow-overlap` | run, task, agent | off | start despite overlapping ownership |
| `--task` | task | | JSON contract, markdown brief, or `-` |
| `--accept`, `--check`, `--file`, `--context` | task | | repeatable; `--context @file` reads a file |
| `--max-repairs` | task, resume | `2` | repair turns after failing checks |
| `--check-timeout-ms` | task, resume | `300000` | per check; checks get `CI=1` when unset |
| `--model` | all turns | `glm-5.3-flash` | `glm-5.3` plus aliases `5.3`, `53`, `flash`, `5.3-flash`, `53f` |
| `--effort` | all turns | `max` | `low`, `medium`, `high`, `xhigh`, `max` |
| `--timeout-ms` | all turns; wait | run 600000, task 1800000 | the whole invocation incl. checks and repairs |
| `--session` | run | | 0.3 compat: continue by zcode id or engine `sess_` id |
| `--profile` | agent | `general-purpose` | subagent profile |
| `--mcp` / `--mcp-inherit` / `--mcp-list` | run, task, agent | hermetic | MCP servers (inline JSON or `@file`) |
| `--skills` / `--no-skills` | run, task, agent | desktop skills | add skills; or run with none |
| `--json`, `--quiet` | all | | see Machine interface |
| `--thinking` / `--no-thinking` | turns | run on, task off | mirror reasoning to stderr |
| `--stream`, `--include-reasoning` | turns | off | deltas in task events; full reasoning in the result |

Only `glm-5.3` and `glm-5.3-flash` are accepted; anything else exits 2 before any spawn. Effort levels `low`, `high`, and `max` have been observed live on Flash. `medium` and `xhigh` may be rejected server-side.

## Exit codes

| code | meaning |
|---|---|
| 0 | completed |
| 1 | unexpected internal error |
| 2 | usage error (bad flag, model, effort, contract, unknown or duplicate session id) |
| 3 | no API key (`zcode login` or `ZAI_API_KEY`) |
| 4 | engine or builtin provider config not found |
| 5 | failed: engine or turn error |
| 6 | `agent`: no subagent dispatched or none ended `success` |
| 7 | workspace conflict, or the session is already running |
| 8 | partial, or checks still failing after repairs |
| 9 | unverified |
| 10 | blocked |
| 124 | `--timeout-ms` exceeded |
| 130 | cancelled |

&nbsp;

## Under the hood

**Key handling.** The key comes from the `ZAI_API_KEY` env var, or from `zcode login`, which stores it at `~/.zcode-cli/credentials.json` (mode 600). It is never printed or logged. Engine messages and check output are scrubbed before they are stored or shown. The only files the key ever lands in are each session's scratch provider config, which the engine requires to register the provider.

**Isolation.** This package's state lives under `~/.zcode-cli`, never under `~/.zcode`, which belongs to the desktop app. Each session's engine runs with `HOME` pointed at its own scratch directory. On every invocation zcode rewrites the scratch config from your live desktop config: provider rule with your key, agent profiles, skills, MCP servers. It never touches the engine's database there, so sessions stay resumable. The desktop's OAuth `credentials.json` is never copied, and the live `~/.zcode` is never written. The engine's ~30 MB plugin cache is shared between sessions through a symlink.

**Yolo mode.** Tool side effects are auto-approved, matching the engine's own headless default; `--cwd` is the blast radius. If a headless turn requests interactive input, the result is reported as `blocked` instead of hanging. The executor contract forbids commits, pushes, deploys, and other external side effects unless the task explicitly asks for them.

**Environment.** `ZAI_CODE_HOME` (state root), `ZAI_CODE_ENGINE` (engine bundle), `ZAI_CODE_NODE` (engine interpreter), `ZAI_CODE_BUILTIN_PROVIDER_CONFIG`, `ZAI_CODE_LIVE_DIR` (desktop config dir, default `~/.zcode`), `ZAI_CODE_MAX_ACTIVE`, `NO_COLOR`.

&nbsp;

## Development

Zero dependencies, plain CommonJS, no build step.

```sh
npm test              # unit suite: in-process, scripted fake engine, no CLI spawn, no API calls
npm run test:live     # functional suite: spawns the CLI against the real engine and GLM API
npm run accept:flash  # black-box acceptance runs (real API)
npm run accept:subagent
npm run accept:53
```

Live tests load the key from the repo `.env`, which is never committed or shipped. The design record and the wire-protocol facts pinned live are in `DESIGN.md` (§17 covers the 0.4 executor redesign) and `docs/BUILD-REPORT.md`.

## License

MIT. Source and issues: [github.com/0xgeorgemathew/zcode](https://github.com/0xgeorgemathew/zcode).

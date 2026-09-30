# zcode

Headless GLM-5.3 / GLM-5.3-Flash turns for agents, with the full agentic runtime underneath: subagents that do real work, MCP servers, skills, session memory. Zero dependencies. One binary, NDJSON out.

Built for agent callers, not humans: stable machine contract on stdout, everything a watcher needs on stderr, explicit exit codes, no surprises.

```text
$ zcode "What is 17*23? Reason carefully, then reply with only the number."
│ The user wants 17 * 23. Simple math. 17*23 = 17*20 + 17*3 = 340 + 51 = 391. Reply with only the number.
391
  GLM-5.3-Flash  ·  effort max  ·  0 tool calls  ·  9.1s  ·  sess_03bf3114-44
```

That is a real transcript. Thinking streams as a dimmed quote block on stderr, the answer lands alone on stdout, and a status line closes the turn. What you pipe is exactly what the model answered.

[![npm](https://img.shields.io/npm/v/@0xgeorgemathew/zcode.svg)](https://www.npmjs.com/package/@0xgeorgemathew/zcode)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

&nbsp;

## Install

```sh
npm install -g @0xgeorgemathew/zcode
```

Needs node 20 or newer for the CLI, 26 recommended for the engine child, plus the ZCode engine on the machine (today: the copy bundled with the ZCode desktop app, resolved automatically).

&nbsp;

## Start in three commands

```sh
echo "$ZAI_API_KEY" | zcode login    # store your Z.AI key (mode 600, never printed)
zcode doctor                         # check engine, isolation, key
zcode "Explain this repo in two sentences"
```

&nbsp;

## Ask

```sh
zcode "Reply with exactly: OK"                          # GLM-5.3-Flash, effort max
zcode --model glm-5.3 "Reply with exactly: OK"          # GLM-5.3
zcode --effort high "Draft a commit message"            # low | medium | high | xhigh | max
echo "$PROMPT" | zcode                                  # prompt via stdin
```

Only `glm-5.3` and `glm-5.3-flash` (plus short aliases) are accepted. Anything else exits 2 before any engine spawn or API call. Default effort is max.

&nbsp;

## Watch it work

Plain mode keeps two streams apart on purpose:

- **stdout** carries the answer, nothing else. Pipe it, capture it, trust it.
- **stderr** is the live feed, all dimmed so it visually recedes: thinking as `│ ` quote lines, tool calls as `→ started` / `✓ ok` / `✗ error`, then one status line with model, effort, tool count, duration, and the session id.

```text
$ zcode "Create a file named note.txt containing exactly the word ready, then reply with just: DONE"
│ This is a trivial task: create note.txt containing exactly the word "ready", then reply with just "DONE".
│ …
→ Write started
DONE
  GLM-5.3-Flash  ·  effort max  ·  1 tool call  ·  11.1s  ·  sess_e9fc3633-3b
```

`--quiet` silences the stderr feed. `--include-reasoning` puts the full thinking text into the JSON result line.

&nbsp;

## Continue a conversation

Every result carries a `sessionId`. Sessions persist on disk, so a later invocation, in a new process, picks up the same thread:

```sh
SID=$(zcode --json "Remember the secret word BANANA. Reply with exactly: OK" | tail -1 | jq -r .sessionId)

zcode --session "$SID" "Reply with only the secret word I told you."    # -> BANANA
```

The continued result line reports `"resumed": true` with the same `sessionId`. The status footer shows the short id so plain-mode callers can continue without a JSON round-trip.

&nbsp;

## Dispatch a subagent

`zcode agent` forces a dispatch through the Agent tool and verifies the outcome programmatically. It never trusts the model's prose: exit 0 only if the parent turn succeeded and at least one subagent ended with status `success`.

```sh
WORK=$(mktemp -d)
zcode agent --cwd "$WORK" \
  "Use the Agent tool to create hello.txt containing exactly HELLO-SUBAGENT, then report the agent id."
cat "$WORK/hello.txt"        # HELLO-SUBAGENT
```

Use `--cwd` to declare where the subagent may work. `--profile` picks the subagent profile (default `general-purpose`; your own `~/.zcode/agents/*.md` profiles resolve too). With `--json`, the final line carries the engine-reported evidence:

```json
"subagents": [{
  "agentId": "agent_8f5144b0-…",
  "childSessionId": "sess_subagent_agent_8f5144b0-…",
  "profileId": "general-purpose",
  "status": "success",
  "summary": "…the subagent's own report…",
  "durationMs": 59765
}]
```

&nbsp;

## MCP servers

Hermetic by default: a run registers only the servers you pass. `--mcp` takes inline JSON or `@file`, repeatable; stdio, http, and sse are supported.

```sh
zcode --mcp '{"word-server":{"type":"stdio","command":"node","args":["srv.js"],"enabled":true}}' \
      "Call get_magic_word and reply with exactly what it returns"

zcode --mcp '{"docs":{"type":"http","url":"https://mcp.example.com/mcp","headers":{"Authorization":"Bearer …"}}}' \
      "Look up the MCP spec section on tools"

zcode --mcp @servers.json --mcp-list      # print the effective set as JSON
zcode --mcp-inherit …                     # also load the desktop's enabled servers
```

The CLI forces the connection and waits until your servers have settled before sending the prompt, so the first turn never misses a slow stdio spawn. Connection state streams to stderr (`◇ mcp word-server connected`) and into the JSON events. Inheritance is opt-in because desktop sets often include browser-OAuth servers that can never finish headless, and they stall the engine's connect pool.

&nbsp;

## Skills

Two ways, both real: the model loads skills through its Skill tool.

- **Project skills, zero flags.** Put `<name>/SKILL.md` under `<workspace>/.zcode/skills/`. The engine walks your workspace; no copy, no flag.

- **Injected per run.** `--skills <dir>` where dir is one skill (has `SKILL.md`) or a root of `<name>/SKILL.md` dirs. Copied into the isolated scratch for this run, removed after.

```sh
zcode --skills ./my-skills "Load the word-vault skill, then reply with the magic word it defines."
```

`--no-skills` runs with an empty skill set. Your desktop user skills (`~/.zcode/skills`) are inherited into the isolation automatically.

&nbsp;

## Machine interface

`--json` emits NDJSON events on stdout with a stable final line:

```json
{"type":"result","ok":true,"response":"…","model":"GLM-5.3-Flash","mode":"yolo",
 "effort":"max","sessionId":"sess_…","resumed":false,
 "usage":{"inputTokens":19608,"outputTokens":3},
 "reasoningChars":2531,"toolCalls":2,"toolEvents":9,
 "mcpServers":["word-server"],"skillsInjected":["word-vault"],
 "durationMs":21972}
```

`model` and `effort` are engine-reported values cross-checked from the engine's own `model_request_started` event, not the wrapper's echo. A failed run still prints a final line with `"ok":false` plus the error kind, so a caller always gets one parseable frame.

Event types on the way in:

| event | meaning |
|---|---|
| `{"type":"stream","kind":"text_delta","delta":"…"}` | answer text, live |
| `{"type":"stream","kind":"reasoning_delta","delta":"…"}` | thinking, live |
| `{"type":"tool","name":"Bash","phase":"started"}` | tool lifecycle: scheduled, started, result, error |
| `{"type":"mcp","name":"word-server","status":"connected","toolCount":1}` | your MCP servers settling |
| `{"type":"model_request_started",…}` | engine-reported model and reasoning level |
| `{"type":"state","mode":"yolo"}` | session mode |

&nbsp;

## Options

| option | takes | default | notes |
|---|---|---|---|
| `--model` | id | `glm-5.3-flash` | `glm-5.3` plus aliases: `5.3`, `53`, `flash`, `5.3-flash`, `53f` |
| `--effort` | level | `max` | `low`, `medium`, `high`, `xhigh`, `max` |
| `--cwd` | dir | current dir | the session workspace, and the blast radius |
| `--session` | id | new session | continue a previous conversation |
| `--mcp` | JSON or `@file` | none | repeatable; stdio, http, sse |
| `--mcp-inherit` | flag | off | also load desktop-enabled MCP servers |
| `--mcp-list` | flag | | print effective servers as JSON, exit |
| `--skills` | dir | none | repeatable; one skill or a root of skills |
| `--no-skills` | flag | off | empty skill set for this run |
| `--profile` | name | `general-purpose` | subagent profile for `agent` |
| `--include-reasoning` | flag | off | full thinking text in the result line |
| `--quiet` | flag | off | silence the stderr live feed |
| `--json` | flag | off | NDJSON events plus result line on stdout |
| `--timeout-ms` | number | `600000` | |
| `--fresh` | flag | off | rebuild the isolated scratch HOME first |
| `-p`, `--prompt` | text | | alias for the positional prompt |

## Exit codes

| code | meaning |
|---|---|
| 0 | success |
| 1 | unexpected internal error |
| 2 | usage error, unknown model, unknown effort, bad `--mcp` JSON |
| 3 | no API key (`zcode login` or `ZAI_API_KEY`) |
| 4 | engine or builtin provider config not found |
| 5 | turn failed (engine error, failed terminal, user-input request) |
| 6 | `agent`: no subagent dispatched or none ended `success` |
| 124 | `--timeout-ms` exceeded |
| 130 | interrupted (SIGINT) |

&nbsp;

## Under the hood

**Key handling.** `ZAI_API_KEY` env var, or `zcode login` which stores it at `~/.zcode/credentials.json` (mode 600). The key is never printed or logged. The only file it ever lands in is the scratch provider config, which the engine requires to register the provider.

**Isolation.** The engine runs with `HOME` pointed at a scratch copy this package owns (`~/.zcode/home`, mode 700, mtime-cached). Your live `~/.zcode`, which the desktop app is using right now, is never written to. Your OAuth `credentials.json` is deliberately never copied. The scratch keeps exactly the `zai-api` provider rule with your key, your agents, and your skills.

**Yolo mode.** Sessions run with auto-approved tool side effects, matching the engine's own headless default; `--cwd` is the declared blast radius. A headless run that requests interactive user input fails fast with exit 5 rather than hanging.

**Engine.** Resolved from the ZCode desktop app bundle (`zcode doctor` prints path, version, sha256). `ZAI_CODE_ENGINE` points elsewhere if you need to pin one. macOS today; nothing else in the wrapper is macOS-specific.

&nbsp;

## Development

Zero dependencies, plain CommonJS, no build step.

```sh
npm test              # functional only, no mocks; live tests hit the real GLM API
npm run accept:flash  # one-shot through GLM-5.3-Flash
npm run accept:subagent
npm run accept:53
```

Tests load the key from the repo `.env` (never committed, never shipped). The design record and pinned wire facts live in `DESIGN.md` and `docs/BUILD-REPORT.md`.

MIT license.

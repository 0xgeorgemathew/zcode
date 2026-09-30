# zai-code

A thin, zero-dependency Node CLI for headless **GLM-5.3 / GLM-5.3-Flash**
coding turns. It drives the ZCode engine's `app-server --stdio` JSON
protocol, so it inherits the full agentic runtime — subagents that do real
work, MCP servers, skills — behind a small, scriptable surface built for
**agent callers, not humans**: NDJSON events, stable result line, explicit
exit codes, session continuity.

## Install

```sh
npm install -g zai-code
```

Requirements: node ≥ 20 for the CLI (≥ 26 recommended for the engine child —
see [Engine requirements](#engine-requirements)), and the ZCode engine on the
machine (today: the copy bundled with the ZCode desktop app, resolved
automatically; `ZAI_CODE_ENGINE` can point elsewhere). Zero runtime
dependencies.

## Usage

```sh
# 1. Configure your Z.AI API key (never printed, stored mode 600)
echo "$ZAI_API_KEY" | zai-code login     # or just export ZAI_API_KEY

# 2. Sanity-check the setup (engine, scratch HOME, key)
zai-code doctor

# 3. One-shot turn (default model: glm-5.3-flash, default effort: max)
zai-code "Explain this repo in two sentences"
zai-code --model glm-5.3 --effort high --json "Reply with exactly: OK"

# 4. Dispatch a subagent that must do real work (verified, not trusted)
zai-code agent --cwd "$WORK" "Use the Agent tool to create hello.txt containing HELLO-SUBAGENT"
```

Full option reference and the `--json` contract are at the bottom.

## Models and effort

| | |
|---|---|
| Allowed models | `glm-5.3` (GLM-5.3) and `glm-5.3-flash` (GLM-5.3-Flash) — aliases: `5.3`, `53`, `5.3-flash`, `flash`, `53f`. Anything else exits 2 **before any engine spawn or API call**. |
| Default model | `glm-5.3-flash` (cheap/fast; `--model glm-5.3` for the acceptance-grade model) |
| Effort | `--effort low\|medium\|high\|xhigh\|max`, default **max**. Sent on every turn (`session/create` `model.options.reasoningLevel` + `thoughtLevel`, `session/send` `modelSelection.options.reasoningLevel`); verified on the wire via the engine's own rollout captures (`request.body.output_config.effort`). Levels beyond low/high/max may be rejected per-model; errors surface verbatim with exit 5. |

## Yolo mode and the `--cwd` blast radius

All sessions run in **yolo mode**: the wrapper forces `mode:"yolo"` right
after `session/create` (`session/setMode`), matching the engine's own `-p`
default, so tool side effects — including subagent file writes — are
auto-approved and never stall on an interactive permission prompt. The
declared blast radius is the session workspace: `--cwd <dir>` (default
`process.cwd()`). Point it at a directory you are willing to let the agent
modify. As defense in depth the client still answers any
`interaction/requestPermission` with an explicit allow, and any
`interaction/requestUserInput` fails the run immediately (exit 5) — a
headless script has no user.

## Thinking (reasoning) while it runs

GLM-5.3 reasons before it answers, and the CLI never hides it:

- `--json`: `{"type":"stream","kind":"reasoning_delta","delta":"…"}` events
  stream live on stdout alongside `text_delta` — an agent can watch thinking
  and answer text as they arrive.
- plain mode: reasoning is mirrored to **stderr** live (dimmed on a TTY,
  prefixed `[reasoning] `) while stdout carries only the answer — pipe
  stdout, watch stderr. `--quiet` suppresses the mirror.
- the final result reports `reasoningChars`, and `--include-reasoning` adds
  the full `reasoning` text to the result line.

## MCP servers

MCP config is inherited from the desktop (`~/.zcode/cli/config.json`,
enabled servers only) into the isolated scratch HOME — then `--mcp` adds
servers per invocation without touching anything global:

```sh
# stdio server (JSON inline or @file)
zai-code --mcp '{"word-server":{"type":"stdio","command":"node","args":["srv.js"],"enabled":true}}' \
         "Call get_magic_word and reply with exactly what it returns"

# remote server
zai-code --mcp '{"docs":{"type":"http","url":"https://mcp.example.com/mcp","headers":{"Authorization":"Bearer …"}}}' …

zai-code --mcp @servers.json --mcp-list   # print the effective set as JSON
zai-code --no-mcp …                        # hermetic: no servers at all (then --mcp still adds)
```

The CLI **waits for explicitly-added servers to finish connecting** before
sending the prompt (stdio servers spawn asynchronously; without the wait the
first turn can miss them), emits `{"type":"mcp","name","status","toolCount"}`
events in `--json` mode, and lists the effective servers in the result
(`mcpServers`). Config schema per server: `{"type":"stdio","command","args","env","cwd"}`
or `{"type":"http"|"sse","url","headers"}` (plus optional `enabled`,
`timeoutMs`). Overlays are recomputed per run — one run's `--mcp` never
leaks into the next.

## Skills

Two ways, both real (the model loads them through its Skill tool):

- **Project skills, zero flags**: put `<name>/SKILL.md` under
  `<workspace>/.zcode/skills/` (the engine walks the workspace; no copy, no
  flag — `--cwd` is all it takes).
- **Injected skills**: `--skills <dir>` where dir is one skill (has
  `SKILL.md`) or a root of `<name>/SKILL.md` dirs — copied into the scratch
  HOME for this run, removed afterwards (`skillsInjected` in the result).
  `--no-skills` runs with an empty skill set.

User skills from the desktop (`~/.zcode/skills`) are inherited into the
scratch HOME at build time (count in `zai-code doctor`).

## Session continuity (multi-turn agents)

Every result carries `sessionId`; sessions persist in the scratch HOME's
SQLite store, so a later CLI invocation — a new engine process — continues
the same conversation:

```sh
SID=$(zai-code --json "Remember the secret word BANANA. Reply with exactly: OK" | tail -1 | jq -r .sessionId)
zai-code --session "$SID" "Reply with only the secret word I told you."   # → BANANA
```

The continued result line has `"resumed": true` and the same `sessionId`.

## Subagents

`zai-code agent` wraps your instructions in a dispatch-forcing preamble (the
model MUST call the in-session `Agent` tool), runs the turn in yolo mode, and
then verifies the outcome programmatically — it never trusts the prose. Exit
0 only if the parent turn succeeded AND at least one subagent ended with
status `success` (exit 6 otherwise). Use `--cwd` to declare where the
subagent may work:

```sh
WORK=$(mktemp -d)
zai-code agent --json --cwd "$WORK" --profile general-purpose \
  "Use the Agent tool to create the file hello.txt in the current directory containing exactly HELLO-SUBAGENT, then report the agent id." \
  | tail -1 | jq .subagents
```

The final `--json` line carries the joined, engine-reported evidence:

```json
"subagents": [{
  "agentId": "agent_8f5144b0-…",
  "childSessionId": "sess_subagent_agent_8f5144b0-…",
  "profileId": "general-purpose",
  "status": "success",
  "summary": "…the subagent's own report…",
  "output": "…",
  "durationMs": 59765
}]
```

Built-in profiles (like `general-purpose`) need no setup; user-defined
profiles under `~/.zcode/agents/*.md` are carried into the scratch HOME so
they keep resolving (custom-profile resolution is documented, not test-gated).
Note `status:"success"` means the subagent *returned* — when the work itself
matters, check the artifact, which is exactly what the acceptance gate does
(`accept:subagent` asserts `done.txt` content byte-for-byte).

## Isolation: your live `~/.zcode` is never touched

`zai-code` never writes to the desktop app's state. The engine is spawned
with `HOME` pointed at a scratch copy that this package owns
(`~/.zai-code/home`, mode 700), built once and mtime-cached
(`zai-code doctor --fresh` rebuilds):

- Only the **top-level files** of `~/.zcode/v2` are copied (JSON state
  files). The 1.2 GB of logs/sessions/checkpoints and the sqlite index are
  not. **Your OAuth `credentials.json` is deliberately never copied** — the
  account providers are structurally inoperative inside the scratch, and the
  copy was live-verified to still register `zai-api/GLM-5.3-Flash`.
- The scratch `provider_config.json` keeps **only** the `zai-api` rule, with
  its `access.apiKey` swapped to the key this package resolved (mode 600).
  Imported third-party rules are pruned.
- `~/.zcode/agents/*.md` and `~/.zcode/AGENTS.md` are copied so
  user-defined agent profiles resolve; the built-in profiles (e.g.
  `general-purpose`) need no copy.
- Uncontrolled env overrides (`ZCODE_STORAGE_DIR`, `ZCODE_DATA_BASE_DIR`,
  `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE`, `ANTHROPIC_API_KEY`,
  `ANTHROPIC_BASE_URL`) are deleted from the child environment; the builtin
  provider config is pinned via `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE`.
- On a fresh machine with no `~/.zcode` at all, a minimal provider config is
  synthesized — **experimental/unproven**; `doctor` reports
  `"isolationMode":"synthesized"` for that path.

Your real workspace (`--cwd`) is of course used for real work — config is
isolated, work is not.

## Key handling

`ZAI_API_KEY` env var → `~/.zai-code/credentials.json` (written by
`zai-code login`, mode 600 under a mode-700 root). No key → exit 3. The key
is never printed or logged; the only file it ever lands in is the scratch
`provider_config.json` (the engine requires it there to register the
provider — an env-var fallback provably does not register).

## Engine requirements

- The engine is the one bundled with the ZCode desktop app:
  `/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs` (resolved
  automatically). Point `ZAI_CODE_ENGINE` at another copy (or a directory
  containing `zcode.cjs`) to pin one; `zai-code doctor` prints the resolved
  path, version and sha256.
- **node ≥ 26 recommended** for the engine child (it has only been tested
  under v26.x). The wrapper itself only needs node ≥ 20; when the spawning
  node is older than 26, `doctor` warns and you can set `ZAI_CODE_NODE` to
  a newer interpreter for the engine spawn.
- macOS today (the app-bundle path is macOS-specific; nothing else in the
  wrapper is).

## `--json` contract

NDJSON events on stdout, final line (stable for scripts):

```json
{"type":"result","ok":true,"response":"…","model":"GLM-5.3-Flash","mode":"yolo",
 "effort":"max","sessionId":"sess_…","resumed":false,
 "usage":{"inputTokens":19608,"outputTokens":3},
 "reasoningChars":2531,"toolCalls":2,"toolEvents":9,
 "mcpServers":["context7","word-server"],"skillsInjected":["word-vault"],
 "durationMs":21972}
```

`model`/`effort` are engine-reported values cross-checked from the engine's
own `model_request_started` event, not the wrapper's echo. Intermediate
lines: `{"type":"stream","kind":"text_delta"|"reasoning_delta"|…}` (live
deltas — reasoning_delta is the thinking), `{"type":"tool","name","phase"}`
(tool lifecycle), `{"type":"mcp","name","status","toolCount"}` (explicit
servers settling), `{"type":"model_request_started",…}`, `{"type":"state",…}`,
`{"type":"turn",…}`. `agent` adds
`"subagents":[{agentId,childSessionId,profileId,status,summary,output,…}]`
from the `session/subagents` RPC joined with the on-disk agent artifacts.

## Exit codes

| code | meaning |
|---|---|
| 0 | success |
| 1 | unexpected internal error |
| 2 | usage error / unknown model / unknown effort |
| 3 | no API key (`zai-code login` or `ZAI_API_KEY`) |
| 4 | engine or builtin provider config not found |
| 5 | turn failed (engine error, failed terminal, user-input request) |
| 6 | `agent`: no subagent dispatched or none ended `success` |
| 124 | `--timeout-ms` exceeded |

## Options

```
--model <id>      glm-5.3 | glm-5.3-flash (+aliases). default: glm-5.3-flash
--effort <level>  low | medium | high | xhigh | max. default: max
--cwd <dir>       workspace for the session (default: process.cwd())
--profile <name>  subagent profile for `agent` (default: general-purpose)
--session <id>    continue a previous session (multi-turn)
--mcp <json|@f>   add MCP servers (repeatable; stdio/http/sse)
--no-mcp          hermetic: inherit no MCP servers
--mcp-list        print effective MCP servers as JSON, exit
--skills <dir>    inject skill(s) for this run (repeatable)
--no-skills       empty skill set for this run
--include-reasoning  full reasoning text in the result line
--quiet           no reasoning/tool mirror on stderr
--json            NDJSON events + final result line on stdout
--timeout-ms <n>  default 600000
--fresh           rebuild the scratch HOME first
-p, --prompt <t>  prompt text (alias for positional prompt; stdin works too)
--version / --help
```

## Development

Zero dependencies, plain CommonJS, no build step. Tests:
`npm test` (`node --test --test-concurrency=1 "test/**/*.test.js"`) — functional only, no mocks;
the live tests drive the real GLM API through the isolated scratch HOME
(mostly Flash; exactly one GLM-5.3 acceptance run). The repo `.env` (never
committed, never shipped) provides `API-KEY` for the live tests.

Acceptance (definition of done; self-contained gates — run them verbatim
from the repo root on a machine with the engine and a `.env` key. Each loads
the key from `.env`, uses `--effort max`, tees the CLI's `--json` output, and
prints a final `SUCCESS <token>` line — exit 0 only on success):

```sh
npm run accept:flash       # one-shot via GLM-5.3-Flash -> SUCCESS PINEAPPLE
npm run accept:subagent    # subagent creates done.txt (AVOCADO) in a throwaway --cwd -> SUCCESS AVOCADO
npm run accept:53          # one-shot via GLM-5.3 -> SUCCESS PINEAPPLE
```

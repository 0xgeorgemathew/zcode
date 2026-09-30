# BUILD-REPORT — `zcode` v0.2.0

Status: **built, verified, prepared for npm publishing — NOT published.**
Report date: 2026-09-30 (v0.1.0 baseline; same-day v0.2.0 adds MCP, skills,
reasoning visibility, session continuity, agent-first I/O). Everything below
was executed on this machine (darwin 27.0.0 arm64, node v26.5.0) unless
explicitly attributed to design/review record (cited as DESIGN.md).

## What was built (v0.2.0 additions)

`zcode` — a zero-dependency CommonJS Node CLI (`bin/` + `lib/`, no build
step, `"dependencies": {}`) that wraps the ZCode engine bundled with the
desktop app (`/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs`,
v0.16.9), driven headless as `app-server --stdio` over newline-delimited
JSON. v0.2.0 turns it from a one-shot runner into an agent-facing tool:

| Piece | Where |
|---|---|
| argv parsing, command dispatch, exit codes 0/1/2/3/4/5/6/124/130(SIGINT) | `bin/zcode.js` |
| model allowlist (GLM-5.3 / GLM-5.3-Flash only; aliases; default Flash) + effort enum (low–max, default max) | `lib/models.js` |
| engine + builtin provider config resolution (`ZAI_CODE_ENGINE`, PATH, app bundle; `ZAI_CODE_BUILTIN_PROVIDER_CONFIG`) | `lib/engine.js` |
| API key resolution (`ZAI_API_KEY` → `~/.zcode/credentials.json`, mode 600) | `lib/key.js` |
| scratch-HOME isolation (v2 top-level files minus `credentials.json`, zai-api rule prune + key swap, cli config hygiene, agents copy, **skills copy**, mtime-cached stamp, synthesized fresh-machine path) | `lib/isolation.js` |
| **per-run overlays**: MCP servers (`--mcp`/`--no-mcp`, recomputed from live config each run — no leakage between runs) and skill injection (`--skills`, manifest-cleaned) | `lib/overlay.js` |
| NDJSON app-server client + turn orchestration (yolo ladder, server-request policies, streaming **incl. reasoning_delta**, **tool lifecycle events**, **mcp settle events + waitForMcp**, engine-reported model evidence, terminal detection, **session/resume**) | `lib/appserver.js` |
| shared bootstrap (key→engine→isolation→**overlays**→client) | `lib/bootstrap.js` |
| `run`, `agent`, `login`, `doctor`, **`--mcp-list`** commands | `lib/commands/*.js` |
| acceptance gates runner (black-box, loads `.env`, `--effort max`, `SUCCESS <token>` line) | `scripts/accept.js` |

Agent-first behaviors added in v0.2.0: `--session <id>` continues a
conversation across processes (sessions persist in the scratch HOME's
SQLite); prompts via stdin; `reasoningChars`/`toolCalls`/`toolEvents`/
`mcpServers`/`skillsInjected`/`resumed` in the stable result line;
`--include-reasoning`; reasoning mirrored to stderr live in plain mode
(`--quiet` to suppress); tool lines on stderr; SIGINT → exit 130.

Product behaviors: one-shot turns (`zcode [prompt…]`), subagent dispatch
with programmatic verification (`zcode agent`), key onboarding
(`zcode login`), and a diagnostics report (`zcode doctor [--json]
[--fresh]`, never prints the key, warns when node < 26). All sessions run in
yolo mode; `--cwd` is the declared blast radius.

## How to use it

```sh
npm install -g zcode            # once published
echo "$ZAI_API_KEY" | zcode login
zcode doctor

zcode "Explain this repo in two sentences"
zcode --model glm-5.3 --effort high --json "Reply with exactly: OK"

# watch it think: plain mode mirrors reasoning to stderr while stdout stays the answer
zcode "What is 17*23? Reason carefully, reply with only the number."

# MCP server for this run only (stdio or http/sse; CLI waits for it to connect)
zcode --mcp '{"word-server":{"type":"stdio","command":"node","args":["srv.js"],"enabled":true}}' \
         "Call get_magic_word and reply with exactly what it returns"
zcode --mcp @servers.json --mcp-list      # effective set as JSON
zcode --no-mcp …                          # hermetic

# skills: project workspace skills need no flags (<workspace>/.zcode/skills/<name>/SKILL.md)
zcode --skills ./my-skills "Load the word-vault skill, reply with the magic word"

# multi-turn: continue a session from a previous invocation
SID=$(zcode --json "Remember BANANA. Reply OK" | tail -1 | jq -r .sessionId)
zcode --session "$SID" "Reply with only the secret word."

WORK=$(mktemp -d)
zcode agent --json --cwd "$WORK" --profile general-purpose \
  "Use the Agent tool to create the file hello.txt in the current directory containing exactly HELLO-SUBAGENT, then report the agent id." \
  | tail -1 | jq .subagents
```

Full surface: README.md (install, usage, subagent example, `--json`
contract, exit codes, isolation explanation). Design rationale and the
live-pinned wire protocol facts: DESIGN.md (§1–§15 design, §16 Builder
findings).

## What was verified (checks run, with commands and outcomes)

### Functional suite — PASS (this session, 2026-09-30, at the final tree)

Command: `CI=false npm test`
(= `node --test --test-concurrency=1 "test/**/*.test.js"`).

Result (v0.1.0 baseline): 10 tests / 10 pass; v0.2.0 adds 4 test files
(mcp, skills, reasoning, session — live where they prove real wiring).
Headless, no watch mode, key loaded from the repo `.env` (`API-KEY`,
line-parsed). The suite is functional-only — no mocks; every test drives
`bin/zcode.js` as a real child process, and the live tests hit the real
GLM API through the isolated scratch HOME:

| test | what it proves |
|---|---|
| `test/allowlist.test.js` | `gpt-4o` / `GLM-4.6` rejected exit 2 before any spawn |
| `test/missing-key.test.js` | no key anywhere → exit 3, actionable message |
| `test/doctor.test.js` | isolation build: scratch provider_config ≤600 holding exactly the zai-api rule; scratch key sha256 == loaded key sha256 ≠ live key sha256; **no `credentials.json` anywhere in scratch immediately after the isolation build** (during live turns the engine child itself later writes its own MCP-OAuth `credentials.json` into the scratch — mode 600, no API key; the wrapper never copies credentials in); live `~/.zcode/v2/provider_config.json` + `~/.zcode/cli/config.json` mtimes identical before/after |
| `test/run-flash.test.js` (live, Flash) | one-shot `OK`; engine-reported model (`model_request_started`) = GLM-5.3-Flash; effort max; mode yolo (gates the permission story); usage.outputTokens > 0; ≥1 streaming event |
| `test/effort-flag.test.js` (live, Flash) | `--effort high` verified on the wire from the engine's rollout capture (`request.body.output_config.effort === "high"`, `thinking.type === "enabled"`); bogus effort exit 2 |
| `test/agent.test.js` (live, Flash) | subagent really dispatched: `session/subagents` + scratch agents-dir join, all status success; `hello.txt` created inside `--cwd` with byte-exact `HELLO-SUBAGENT`; yolo mode |
| `test/glm53-acceptance.test.js` (live, GLM-5.3 — the only one) | `OK` with engine-reported model GLM-5.3 |
| `test/mcp.test.js` | `--mcp` invalid JSON → exit 2 pre-spawn; `--mcp-list` prints the effective set incl. the added server; default set hermetic + `--mcp-inherit` lists the desktop servers; **LIVE**: a real zero-dep stdio MCP server (`test/fixtures/mcp-word-server.js`, tool `get_magic_word`) is spawned by the engine and its tool is called by the model → `PAPAYA` (the word exists nowhere else — proof of a full config→spawn→tools/list→tools/call round-trip; passed 3× consecutively at ~15 s each) |
| `test/skills.test.js` | doctor reports skills inherited from live `~/.zcode/skills` (structural, no API); **LIVE**: `--skills` injects the real `word-vault` skill and the model loads it via the Skill tool → `BLUEBERRY` (word exists only in the fixture) |
| `test/reasoning.test.js` (live, Flash) | `--json` streams `reasoning_delta` events; result `reasoningChars > 0` at effort max; `--include-reasoning` carries the text; plain mode mirrors reasoning to stderr while stdout is only the answer |
| `test/session.test.js` (live, Flash ×2) | run 1 stores BANANA + returns `sessionId`; run 2 (`--session`, new engine process) answers `BANANA`, same `sessionId`, `"resumed": true` — sessions persist in the scratch SQLite across processes |
| `test/pack.test.js` | `npm pack` ships only `bin/`, `lib/`, `README.md`, `LICENSE`, `package.json`; never `.env`, `test/`, `DESIGN.md`; **plus a content scan: no shipped file contains the API key** |

During the build every test was observed RED before its implementation
(DESIGN §12 TDD steps 1–7), with one exception: step 8 (pack) was green on
its first run because the `files` allowlist + LICENSE were created at step 0
per the design's own step-0 instruction.

### v0.2.0 engineering findings (MCP stability, live-pinned)

The first MCP implementation was flaky (coin-flip tool availability).
Root causes, found by instrumenting the fixture and reading the engine's
own JSONL logs (`~/.zcode/home/.zcode/cli/log/`):

1. **Connections are lazy and must be forced.** The engine connects MCP
   servers asynchronously; only `mcp/list mode:"connect"` starts them.
   Observing with `mode:"status"` never triggers a connection, so the CLI
   now forces connect, then polls until the caller's servers settle
   (`waitForMcp`), and only then sends the prompt.
2. **MCP replies must carry `jsonrpc:"2.0"`.** The engine negotiates
   protocol "eras"; its strict-era client drops replies that omit the
   `jsonrpc` field — the server appears to hang and fails with
   `connection_timeout` after 30 s. The fixture now includes it (and
   speaks both newline-JSON and LSP `Content-Length` framing, replying in
   whichever the client used).
3. **Inheritance is opt-in (`--mcp-inherit`), not default.** The desktop's
   server set includes OAuth servers that can never complete headless
   (they stall the engine's connect pool and starve later servers
   nondeterministically) and costs 16 spawns per run. A run now registers
   only what the caller passes with `--mcp` — deterministic and ~5×
   faster to first token in the live test.

### Acceptance gates — PASS (run verbatim via npm)

| gate | command | final stdout line (this session) |
|---|---|---|
| `accept:flash` | `npm run accept:flash` | `SUCCESS PINEAPPLE` (exit 0 re-verified unpiped) |
| `accept:53` | `npm run accept:53` | `SUCCESS PINEAPPLE` |
| `accept:subagent` | `npm run accept:subagent` | `SUCCESS AVOCADO` |

Each gate: loads the key from `.env`, runs `--effort max`, tees the CLI's
`--json` output (subagent completion is visible in the result line:
`subagents[].status:"success"` + summary + agentId), verifies deterministic
evidence (forced token; engine-reported model and effort; for the subagent
gate additionally: ≥1 subagent, all success, and `done.txt` inside the
throwaway `--cwd` containing exactly `AVOCADO`), applies a one-retry budget
for content mismatch/turn failure/timeout (never for config errors), exits 0
only on success, and prints the final `SUCCESS <token>` line. Failure paths
verified live: response mismatch → exit 1 after retry; missing `.env` →
exit 1 with `accept: no API-KEY found in .env at the repo root`.

### Packaging preparation — verified this session

- `npm view zcode version` → **E404 Not Found** (registry.npmjs.org,
  2026-09-30 15:17 UTC): the name `zcode` is available. DESIGN.md §15
  records the fallback (`zcode-glm`, also E404 as of the design session) if
  it is squatted on publish day.
- `package.json`: `bin: {"zcode": "bin/zcode.js"}`; `files:
  ["bin","lib","README.md","LICENSE"]` (source + bin + README + LICENSE;
  `.env`/`test/`/`DESIGN.md`/`docs/`/`scripts/` are excluded by the
  allowlist and their exclusion is test-enforced); `engines: {"node":
  ">=20"}`; `license: "MIT"`; `dependencies: {}`;
  `prepublishOnly: "npm test"` (the functional suite runs before any
  publish).
- Tarball contents inspected via `npm pack --dry-run --json` during the
  suite's pack test: only allowlisted files ship.

### Security/isolation invariants — verified this session

- `.env` was never committed (`git log --all --oneline -- .env` → 0 commits)
  and no key material exists anywhere in git history
  (`git grep -lF <key> $(git rev-list --all)` → empty).
- Live `~/.zcode` untouched by our runs: `~/.zcode/v2/provider_config.json`
  mtime still 2026-09-13 12:01, `~/.zcode/cli/config.json` 2026-09-29 09:56
  (both predate the build), re-asserted by the doctor test on every suite
  run; the desktop app's own writes (logs/db/credentials.json) are out of
  scope by design (DESIGN §6.4).

## What was NOT covered

- **Publishing itself** — deliberately not run (`npm publish` was not
  executed; `npm pack` was, dry-run and via the test).
- **Fresh-machine synthesized-config path** (`isolationMode:"synthesized"`)
  — implemented, marked experimental in `doctor` and README; never verified
  on a machine without `~/.zcode` (DESIGN risk R7).
- **Custom (user-defined) agent profiles** under the scratch HOME —
  `agents/*.md` + `AGENTS.md` are copied so they resolve, but no test gates
  that path; `general-purpose` is built-in (DESIGN risk R4).
- **Engine under node < 26** — the engine child has only ever run under
  v26.5.0. `doctor` warns below 26 and `ZAI_CODE_NODE` overrides (R11);
  the wrapper's own `engines >= 20` is not a claim about the engine child.
- **Non-macOS layouts** — engine resolution lists macOS app-bundle path
  first; nothing in the wrapper is platform-specific but only macOS was
  tested.
- **Effort levels `medium`/`xhigh`** — accepted by the CLI per the bundle
  schema but never exercised live; GLM-5.3's level set was never observed
  (R5). Errors would surface verbatim with exit 5.
- **Interactive TTY prompt path** (`zcode` with no args on a TTY) —
  reads stdin when piped; the TTY no-prompt path just exits 2.
- **`npm audit` / license scanning of dependencies** — trivially empty
  (zero dependencies), not run as a check.

## Caveats

- The engine is an **undocumented internal protocol** of a desktop-app
  bundle (v0.16.9). It can drift on app update; mitigations: `doctor`
  prints engine version + sha256, `ZAI_CODE_ENGINE` pins a known copy,
  unknown server-directed requests get `-32601` (one such method proven
  non-fatal live), and the suite/gates fail loudly on drift (R3).
- **Yolo mode auto-approves tool side effects.** Intentional (scripting
  agent; identical to the engine's own `-p` default); `--cwd` is the
  documented blast radius (R12). All tests and gates use throwaway temp
  dirs.
- The API key must exist in the scratch `provider_config.json` (engine
  requirement; env fallback proven insufficient). It is mode 600 under a
  mode-700 root, never printed/logged/committed, and the pack test
  guarantees it never ships (R6).
- Live-model assertions can flake; the suite and gates share the
  determinism policy: `trim()` comparisons, wire-level evidence from
  engine-side artifacts (telemetry events, rollout captures), one retry on
  content mismatch/turn failure/timeout, none on config errors.
- First run on a machine pays the one-time isolation build + engine spawn
  (~1 s build here; 1.2 GB source dir is NOT copied wholesale — top-level
  JSON files only); later runs are spawn-only (`--fresh` forces rebuild).
- `zcode login` was verified manually (scratch home, mode 600, no key
  echo) rather than by a suite test — the design's test tally is fixed at
  8 files / 10 cases.

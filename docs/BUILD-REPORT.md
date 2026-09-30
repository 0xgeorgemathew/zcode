# BUILD-REPORT — `zai-code` v0.1.0

Status: **built, verified, prepared for npm publishing — NOT published.**
Report date: 2026-09-30. Everything below was executed on this machine
(darwin 27.0.0 arm64, node v26.5.0) unless explicitly attributed to the
design/review record (cited as DESIGN.md).

## What was built

`zai-code` — a zero-dependency CommonJS Node CLI (`bin/` + `lib/`, no build
step, `"dependencies": {}`) that wraps the ZCode engine bundled with the
desktop app (`/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs`,
v0.16.9), driven headless as `app-server --stdio` over newline-delimited
JSON:

| Piece | Where |
|---|---|
| argv parsing, command dispatch, exit codes 0/1/2/3/4/5/6/124 | `bin/zai-code.js` |
| model allowlist (GLM-5.3 / GLM-5.3-Flash only; aliases; default Flash) + effort enum (low–max, default max) | `lib/models.js` |
| engine + builtin provider config resolution (`ZAI_CODE_ENGINE`, PATH, app bundle; `ZAI_CODE_BUILTIN_PROVIDER_CONFIG`) | `lib/engine.js` |
| API key resolution (`ZAI_API_KEY` → `~/.zai-code/credentials.json`, mode 600) | `lib/key.js` |
| scratch-HOME isolation (v2 top-level files minus `credentials.json`, zai-api rule prune + key swap, cli config hygiene, agents copy, mtime-cached stamp, synthesized fresh-machine path) | `lib/isolation.js` |
| NDJSON app-server client + one-turn orchestration (yolo ladder via `session/setMode`, per-method server-request policies, streaming, engine-reported model evidence, terminal detection) | `lib/appserver.js` |
| shared bootstrap (key→engine→isolation→client) | `lib/bootstrap.js` |
| `run`, `agent`, `login`, `doctor` commands | `lib/commands/*.js` |
| acceptance gates runner (black-box, loads `.env`, `--effort max`, `SUCCESS <token>` line) | `scripts/accept.js` |

Product behaviors: one-shot turns (`zai-code [prompt…]`), subagent dispatch
with programmatic verification (`zai-code agent`), key onboarding
(`zai-code login`), and a diagnostics report (`zai-code doctor [--json]
[--fresh]`, never prints the key, warns when node < 26). All sessions run in
yolo mode; `--cwd` is the declared blast radius.

## How to use it

```sh
npm install -g zai-code            # once published
echo "$ZAI_API_KEY" | zai-code login
zai-code doctor

zai-code "Explain this repo in two sentences"
zai-code --model glm-5.3 --effort high --json "Reply with exactly: OK"

WORK=$(mktemp -d)
zai-code agent --json --cwd "$WORK" --profile general-purpose \
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

Result: **10 tests / 10 pass / 0 fail**, 171 s, headless, no watch mode,
key loaded from the repo `.env` (`API-KEY`, line-parsed). The suite is
functional-only — no mocks; every test drives `bin/zai-code.js` as a real
child process, and 4 tests hit the live GLM API through the isolated
scratch HOME:

| test | what it proves |
|---|---|
| `test/allowlist.test.js` | `gpt-4o` / `GLM-4.6` rejected exit 2 before any spawn |
| `test/missing-key.test.js` | no key anywhere → exit 3, actionable message |
| `test/doctor.test.js` | isolation build: scratch provider_config ≤600 holding exactly the zai-api rule; scratch key sha256 == loaded key sha256 ≠ live key sha256; **no `credentials.json` anywhere in scratch**; live `~/.zcode/v2/provider_config.json` + `~/.zcode/cli/config.json` mtimes identical before/after |
| `test/run-flash.test.js` (live, Flash) | one-shot `OK`; engine-reported model (`model_request_started`) = GLM-5.3-Flash; effort max; mode yolo (gates the permission story); usage.outputTokens > 0; ≥1 streaming event |
| `test/effort-flag.test.js` (live, Flash) | `--effort high` verified on the wire from the engine's rollout capture (`request.body.output_config.effort === "high"`, `thinking.type === "enabled"`); bogus effort exit 2 |
| `test/agent.test.js` (live, Flash) | subagent really dispatched: `session/subagents` + scratch agents-dir join, all status success; `hello.txt` created inside `--cwd` with byte-exact `HELLO-SUBAGENT`; yolo mode |
| `test/glm53-acceptance.test.js` (live, GLM-5.3 — the only one) | `OK` with engine-reported model GLM-5.3 |
| `test/pack.test.js` | `npm pack` ships only `bin/`, `lib/`, `README.md`, `LICENSE`, `package.json`; never `.env`, `test/`, `DESIGN.md`; **plus a content scan: no shipped file contains the API key** |

During the build every test was observed RED before its implementation
(DESIGN §12 TDD steps 1–7), with one exception: step 8 (pack) was green on
its first run because the `files` allowlist + LICENSE were created at step 0
per the design's own step-0 instruction.

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

- `npm view zai-code version` → **E404 Not Found** (registry.npmjs.org,
  2026-09-30 15:17 UTC): the name `zai-code` is available. DESIGN.md §15
  records the fallback (`zcode-glm`, also E404 as of the design session) if
  it is squatted on publish day.
- `package.json`: `bin: {"zai-code": "bin/zai-code.js"}`; `files:
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
- **Interactive TTY prompt path** (`zai-code` with no args on a TTY) —
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
- `zai-code login` was verified manually (scratch home, mode 600, no key
  echo) rather than by a suite test — the design's test tally is fixed at
  8 files / 10 cases.

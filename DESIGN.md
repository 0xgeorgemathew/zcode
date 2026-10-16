# DESIGN — `zai-code`: a GLM-5.3 / GLM-5.3-Flash coding CLI

Design doc for the npm package to be built in this repo. Written by the Designer
role; the Builder owns implementation, git-init, and publishing. Every claim
below is grounded either in a check run during this design session (command and
result cited), in the design-review feedback (cited as "review:", each of those
checks was run by the reviewer, not by me), or in the app-research bundle
supplied with the ask (cited as "research:"). Nothing is speculative except
where explicitly marked **unproven**.

Revision 2 — incorporates design-review findings: permission/mode strategy for
subagent runs (§9.1), `credentials.json` excluded from the isolation copy
(§6.2), isolation invariant reworded (§6.4), deterministic acceptance
assertions incl. wire-level effort from rollout files (§12), built-in vs
copied agent profiles (§11, R4), the full set of server-directed requests
(§9), and a node-version warning for engine spawn (§4, R11).

---

## 1. Product summary

`zai-code` is a thin, zero-dependency Node CLI that wraps the ZCode engine
bundled with the desktop app (`/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs`,
v0.16.9 — version confirmed this session by running `node …/zcode.cjs --help`
and `…/zcode.cjs version`, both printing `0.16.9`). It gives scripts and humans
a stable, lockable headless surface:

| Hard requirement | Where satisfied |
|---|---|
| GLM 5.3 / GLM 5.3 Flash **only**, others rejected with a clear error | §7 model allowlist at the wrapper layer (exit 2); scratch registry registers only `zai-api` |
| Default reasoning effort = `max` | §8 — sent on every turn in both live-proven wire locations |
| Subagent support (launches a subagent that completes real work) | §11 `zai-code agent` command; verified programmatically via `session/subagents` RPC + on-disk artifacts; runs in yolo mode so tool side effects are auto-approved (§9.1) |
| npm-publish ready | §13 — `files` allowlist, `bin`, `engines`, zero deps; `test/pack.test.js` guards the tarball |
| Functional tests only, real API, no mocks | §12 — `node:test`, no mock layers, 4 tests hit the live API |
| TDD (test written and seen failing first) | §12 — every step is RED → implement → GREEN |
| Most testing on Flash; GLM-5.3 gets one acceptance run | §12 — steps 4/5/6 run Flash; step 7 is the single GLM-5.3 run |
| Fast startup (zero or tiny deps) | §3 — `"dependencies": {}`, no build step, plain CommonJS, isolation built once and cached |

Non-goals: TUI (the engine has one), multi-provider routing, MCP management,
Windows support in v0.1 (engine resolution lists macOS app-bundle path first;
nothing in the wrapper is platform-specific, but only macOS is tested).

---

## 2. Decision: wrap the engine, do not build a standalone client

**Chosen: wrap.** Spawn `node <engine> app-server --stdio` and speak the
newline-delimited JSON protocol that the app inspector proved live end-to-end
(research: `liveVerification`, `headlessCommand` — a real GLM-5.3-Flash
completion, `turn.terminal status:"success"`, 21.9 s, with model + effort
pinned on the wire).

Why not a standalone HTTP client against `https://api.z.ai/api/anthropic`
(the endpoint documented at docs.z.ai/devpack/tool/claude, research:
`zaiApi`):

1. **Model pinning is only proven through the engine.** The `-p` print mode has
   NO `--model`/effort flags (research: `gaps` #4 — "the app-server route is
   the only headless path I proved can pin GLM-5.3-Flash + max effort"). A raw
   Anthropic-messages client could pin the model id, but…
2. **The subagent requirement needs an agent runtime, not a chat endpoint.**
   Subagents are launched by the model calling the in-session `Agent` tool
   (research: `subagentMechanism`), with tool execution, file writes, and
   child-session bookkeeping. Reimplementing that against the bare API is a
   second agent framework, not a wrapper — rejected.
3. **The wire is already characterized.** The inspector's live run gives the
   exact frame format, the `session/requestRuntimePreferences` trap, and the
   completion signals. Wrapping converts verified knowledge into product.

---

## 3. Package identity

- **name: `zai-code`** — checked available on the npm registry this session
  (2026-09-30) by running `npm view zai-code version` → E404 ("not found"),
  while `npm view zai-cli version` → 1.1.0 and `npm view zai version` → 1.0.0
  (both taken). Re-check on publish day; if squatted, fall back to
  `zcode-glm` (also verified available the same way).
- **bin: `zai-code`** → `bin/zai-code.js` with `#!/usr/bin/env node` shebang,
  committed executable (convention per research: `packagingNotes`, precedents
  claude-code/codex).
- **engines: `node >= 20`** for the *wrapper* — it uses only `node:` builtins
  (child_process, fs, path, crypto, readline). Caveat: the wrapper spawns the
  *engine* with the same interpreter, and the engine has only ever been run
  under node v26.5.0 (this machine, `node --version`). `doctor` therefore
  warns when the spawning node major is < 26, and `ZAI_CODE_NODE` lets users
  point at a newer interpreter (§4, risk R11).
- **dependencies: `{}`** — no runtime deps, no native modules, no build step.
  Plain CommonJS `.js` in `bin/` + `lib/` for instant startup.
- **files: `["bin", "lib", "README.md", "LICENSE"]`** — allowlist only; `.env`,
  `test/`, `DESIGN.md`, and scratch state never ship (enforced by
  `test/pack.test.js`, §12 step 8).
- **test runner: `node --test test/`** (built-in runner; zero dev deps).

Module layout:

```
bin/zai-code.js        # shebang entry: parse argv, dispatch command
lib/models.js          # id normalization + allowlist (the ONLY place ids are chosen)
lib/engine.js          # locate engine + builtin provider config
lib/key.js             # key resolution (env → credentials file)
lib/isolation.js       # build/refresh the scratch HOME (§6)
lib/appserver.js       # NDJSON client for `app-server --stdio` (§9)
lib/commands/run.js    # one-shot turn
lib/commands/agent.js  # subagent-dispatching turn + verification (§11)
lib/commands/login.js  # write credentials.json from stdin, mode 600
lib/commands/doctor.js # engine/isolation/key report, never prints the key
```

---

## 4. Engine resolution

Order (first hit wins; `doctor` reports which one, its sha256, and the node
major with a warning when < 26):

1. `ZAI_CODE_ENGINE` env var — path to `zcode.cjs` (or a dir containing it).
2. `zcode` on PATH.
3. `~/.local/bin/zcode`, then `~/.zcode/runtime/` (install.sh layout, research:
   `headlessUsage`).
4. `/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs` — the only copy
   that exists on this machine (verified this session: `command -v zcode` →
   empty; `~/.zcode/runtime` and `~/.local/bin/zcode` do not exist; the bundle
   file exists, 14.8 MB, mode 755).

Built-in provider config: resolved engine-adjacent —
`<engineDir>/../config/provider/zcode-builtin.json` (i.e.
`…/Resources/config/provider/zcode-builtin.json`, verified to exist this
session, 182 KB). Env override `ZAI_CODE_BUILTIN_PROVIDER_CONFIG` wins.
Not found → exit 4 with the probed paths (the engine's own error for a missing
builtin config is "无法定位 CLI ZCode Built-in Provider Config", research:
`apiKeyWiring`).

Spawn: `<node> <engine> app-server --stdio` where `<node>` =
`ZAI_CODE_NODE` || `process.execPath`, with the env described in §6.3.

---

## 5. API key handling — security invariants

- Sources, in order: `ZAI_API_KEY` env var → `~/.zai-code/credentials.json`
  (`{"apiKey":"…"}`, mode 600, written by `zai-code login`, which reads stdin
  with echo off). No key → exit 3: `No API key configured. Run "zai-code login"
  or set ZAI_API_KEY.`
- **Never** printed, logged, echoed in errors, or written anywhere under the
  package repo or the publish tarball. The only file it ever lands in is the
  scratch `provider_config.json` (mode 600, under `~/.zai-code/home/`) because
  the engine requires `access.apiKey` present in the personal provider rule for
  model registration — `ANTHROPIC_API_KEY` env fallback does NOT register the
  provider (research: `gaps` #5, empirically proven "keyless rule → Provider
  Registry 中不存在 Model").
- Tests load the key from the repo `.env` (variable name `API-KEY` — hyphenated,
  so parse the file line-wise; confirmed present this session via
  `grep -c '^API-KEY=' .env` → 1, value never read into output). `.gitignore`
  must contain `.env` before the first commit (Builder step 0 in §12).
- The whole `~/.zai-code/` root is mode 700.

---

## 6. Isolation: scratch HOME (the core mechanism)

Goal: the user's live `~/.zcode` — which the desktop app is running off right
now — is never written by us, and the engine never runs against the user's
live credentials as writable state. Method: run the engine with `HOME`
pointed at a scratch copy that we own. This is the strategy the app inspector
live-proved (research: `apiKeyWiring` — "Isolation that WORKS (live-proven):
copy config state to a scratch HOME and run the CLI with HOME=<scratch> and NO
ZCODE_STORAGE_DIR").

### 6.1 Location and lifecycle

- Root: `ZAI_CODE_HOME` env override, else `~/.zai-code/`. Scratch HOME:
  `<root>/home/` (mode 700). `<root>/build-stamp.json` records source mtimes +
  key fingerprint (sha256, never the key).
- Built **once**, reused across runs (fast startup). Rebuilt when: a source
  file's mtime is newer than the stamp, the key fingerprint changes, or the
  user passes `--fresh`.

### 6.2 Build recipe

The proven recipe was `cp -R ~/.zcode/v2` + `cp ~/.zcode/cli/config.json` +
key swap; we deviate where forced or where the review proved it safe, and each
deviation is gated by a live functional test:

1. **Selective v2 copy — top-level files, `credentials.json` EXCLUDED.**
   `~/.zcode/v2` is **1.2 GB** on this machine (measured this session:
   `du -sh ~/.zcode/v2` → 1.2G; logs 174M, sessions 33M), so a wholesale copy
   is unacceptable; and the live `credentials.json` (the user's OAuth token
   state, 88 KB, mode 600, actively rewritten by the running desktop app —
   review:) must NOT be shipped into our scratch. The review **live-proved**
   the trimmed recipe works: a Tier-(a) copy (top-level files, no
   `credentials.json`, no `certs/`, `runtime/`, `agent-config/` dirs) still
   registered `zai-api/GLM-5.3-Flash` (`session/create` returned
   `sess_22…` with `result.session.model` echoed). So: copy
   `find v2 -maxdepth 1 -type f` **minus `credentials.json`** (i.e. the JSON
   state files: `provider_config.json`, `setting.json`,
   `coding-plan-cache.json`, `config.json`, `model-providers.json`, …), skip
   all directories and `tasks-index.sqlite*`. Excluding `credentials.json`
   also makes the account/OAuth providers genuinely inoperative inside the
   scratch (no tokens to use), which is what R8 always wanted. **Fallback
   ladder** if the live Flash run (§12 step 4) ever fails registration:
   (a) top-level files minus credentials.json [default — review-proven];
   (b) add `certs/`, `runtime/`, `agent-config/` dirs (still no
   `credentials.json`); (c) full `cp -R` minus `logs/`, `sessions/`,
   `checkpoints/`, `credentials.json`. `credentials.json` is never re-added —
   if registration ever seemed to require OAuth tokens, that is a design red
   flag to escalate, not a copy-list tweak.
2. **Rule pruning + key swap.** In the copied `provider_config.json`: keep only
   rules whose `providerId === 'zai-api'` (verified shape this session by
   reading the live file — rule[0] is exactly
   `{providerId:'zai-api', templateId:'zai-api', config:{group:'standard-personal',
   access:{type:'api-key', apiKey:<present>}}}`; the other two rules are
   `imported:claude:*` / `imported:opencode:*` and carry third-party keys we
   have no business copying), then set
   `config.providerConfigRules.providerRules[0].config.access.apiKey = <package
   key>`. Write mode 600. Pruning deviates from the literal proof; gated by
   the same live test, same fallback (keep all rules, swap rule[0]).
3. **cli/config.json hygiene.** If `~/.zcode/cli/config.json` exists, copy it
   to `<home>/.zcode/cli/config.json` and overwrite
   `provider["builtin:zai"].options.apiKey` with the package key (the live file
   carries the user's key under `builtin:zai` — verified this session, key
   presence only). Mode 600. If absent, skip: v2 is the registration point
   (research: `modelRegistration`).
4. **Agent profiles.** Copy `~/.zcode/agents/*.md` (top-level profile files
   only — verified present this session; NOT the tool-proxy subdirs) into
   `<home>/.zcode/agents/`, and `~/.zcode/AGENTS.md` if present. This exists
   so USER-defined custom profiles remain resolvable under the scratch HOME;
   it is NOT needed for `general-purpose`, which the engine resolves from
   built-ins (review: the real `metadata.json` shows
   `profileSnapshot.source:"built-in"` for profileId `general-purpose`). See
   §11 for what the test does and does not gate.
5. **Fresh-machine path (no `~/.zcode` at all):** synthesize a minimal
   `<home>/.zcode/v2/provider_config.json` containing only the zai-api rule
   with the package key, and skip 3–4. **Unproven** (never run live); `doctor`
   reports `"isolationMode":"synthesized"` and the README marks it
   experimental until verified once on a clean HOME.

### 6.3 Child process environment

```
HOME               = <root>/home
ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = <resolved builtin provider config>
```

Explicitly **deleted** from the inherited env before spawn: `ZCODE_STORAGE_DIR`
(research-proven to break zai-api model registration — "Provider Registry 中不存
在 Model"), `ZCODE_DATA_BASE_DIR` (would relocate the v2 root away from our
scratch), `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE` (uncontrolled override),
`ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL` (uncontrolled fallbacks). `cwd` is
the user's real workspace (`--cwd`, default `process.cwd()`) — config is
isolated, work is not. The scratch-HOME engine child writes only under the
scratch HOME (review: observed during a 45 s window — scratch child wrote only
scratch paths).

### 6.4 Isolation invariants (what must always hold)

- **`zai-code` performs no writes to the live `~/.zcode`.** This is the
  invariant the design guarantees; it is deliberately NOT phrased as "live
  mtimes never change", because the running desktop app writes its own state
  concurrently and that must remain none of our business (review, 45 s window:
  `~/.zcode/cli/log/zcode-2026-09-30.jsonl` +~18 KB, `v2/logs/2026-09-30.log`
  +2.4 KB, `cli/db/db.sqlite-wal` bumped — all desktop-app writes while the
  scratch child touched only scratch).
- `test/doctor.test.js` therefore scopes its assertion to the two files that
  carry the credentials state — live `~/.zcode/v2/provider_config.json` and
  `~/.zcode/cli/config.json` — asserting identical `stat` mtimes before/after
  (both were untouched in the review's run). A broader "no mtime changed
  anywhere" assertion would flake on the desktop app's own log writes and is
  explicitly not used.
- Scratch `provider_config.json` key sha256 === loaded key sha256, and ≠ live
  key sha256 (when a live key exists) — same test; comparisons on sha256 hex
  only, key material never printed.
- All files under `<root>/home` that contain the key are mode ≤ 600.

---

## 7. Model registration & the allowlist

Two independent locks, so "GLM 5.3 / Flash only" holds even if one leaks:

1. **Wrapper allowlist (authoritative).** `lib/models.js` normalizes user input
   case-insensitively: `glm-5.3`, `5.3`, `53` → `GLM-5.3`; `glm-5.3-flash`,
   `5.3-flash`, `flash`, `53f` → `GLM-5.3-Flash` (official ids pass through
   verbatim; they are exactly `"GLM-5.3"` / `"GLM-5.3-Flash"` per research:
   `modelRegistration`). Anything else → exit 2:
   `Error: unknown model "<input>". zai-code supports only glm-5.3 and
   glm-5.3-flash (GLM-5.3, GLM-5.3-Flash).` The wrapper constructs **every**
   engine request itself, so no other id can reach the wire.
2. **Registry lock.** The scratch HOME registers only the `zai-api` provider,
   whose template declares `builtinModelIds: ["GLM-5.3","GLM-5.3-Flash"]`
   (research: `modelRegistration`, from
   `/Applications/ZCode.app/Contents/Resources/config/provider/zcode-builtin.json`;
   registration under the trimmed copy re-proven by review, §6.2). Note ids
   must be the exact official uppercase forms — `zai-api` gets NO case
   normalization from the engine (research: `modelRegistration`).

Default model: **GLM-5.3-Flash** (cheap/fast default; the acceptance-grade
GLM-5.3 is one `--model glm-5.3` away — matches "most testing on Flash").

---

## 8. Effort control

- Default `--effort max`. Accepted values `low|medium|high|xhigh|max`
  (normalized lowercase; enum per bundle schema, research: `effortControl`).
- Sent on **every turn in both live-proven locations**, because omitting it
  fails the turn with "Reasoning level is required for zai-api/GLM-5.3-Flash"
  (observed live, research: `effortControl`):
  - `session/create` → `params.model.options.reasoningLevel` AND
    `params.thoughtLevel`;
  - `session/send` → `params.modelSelection.options.reasoningLevel`.
- Live-observed levels for Flash: `[low, high, max]`, default `max`
  (research: `effortControl`, registry event). GLM-5.3's exact level set was
  never observed — `medium`/`xhigh` may be rejected server-side on either
  model (0.5: superseded, the builtin provider config lists `low|high|max` for
  both and zcode refuses anything else before spawning, §18.2). On engine error events the wrapper surfaces the message verbatim and
  exits 5; `max` (the default and the only guaranteed-portable choice) is what
  the user's own logs show on both models (58× max, 34× high, research:
  `effortControl`).

---

## 9. Wire protocol client (`lib/appserver.js`)

Framing and semantics from the live runs (research: `headlessCommand`,
`liveVerification`; review: this session's additional probe):

- **NDJSON over stdio** — one JSON object per line, both directions.
- Requests: `{"id":<n>,"method":"…","params":{…}}`. `id` is REQUIRED (no-id
  messages are treated as notifications and never answered); a `jsonrpc` key
  is REJECTED. Matching responses carry the same `id`; errors as
  `{id, error}`.
- **Server-directed requests: expect several, with a per-method policy.** The
  engine's method map contains `interaction/requestPermission`,
  `interaction/requestUserInput`, and `session/setMode` (confirmed this
  session: `grep -o` occurrence counts in zcode.cjs — 1, 1, and 2
  respectively; plus `session/requestRuntimePreferences` 1) and the
  projection carries `pendingPermissions` (5 occurrences). Observed live so
  far and their policies:

  | Server request | Policy |
  |---|---|
  | `session/requestRuntimePreferences` | **Must answer** with the proven payload `{nativeSearchEnhancementsEnabled:false, memoryEnabled:false, askUserQuestionAutoResolutionEnabled:true, modelContextBudgetStrategy:'preflight-v1'}` or create fails after 15 s (research: `headlessCommand`) |
  | `interaction/requestOfficialMcpAuthHeaders` | Answer `{id, error:{code:-32601}}` and continue — review-proven non-fatal: the reviewer's run left it unanswered and `session/create` still succeeded |
  | `interaction/requestPermission` | **Answer allow** (schema pinned from the first live occurrence, §9.1) — never `-32601`, which plausibly reads as a deny and would kill subagent tool calls |
  | `interaction/requestUserInput` | Answer with an error result and fail the run exit 5 (`headless run requested user input`) — a headless script has no user; failing fast beats hanging 15 s |
  | anything else | `{id, error:{code:-32601}}` and continue (policy validated by the MCP-headers observation) |

- **One run:**
  1. spawn (§4, §6.3)
  2. `session/create` `{workspace:{workspacePath, workspaceKey}, mode:'yolo',
     model:{providerId:'zai-api', modelId, options:{reasoningLevel}},
     thoughtLevel}` → verify the echoed result session reports
     `mode === 'yolo'` and our model; see §9.1 for the mode ladder.
     `workspaceKey`: semantics unknown (the live proof passed an unspecified
     key) — **Builder decision:** `sha256(realpath(workspacePath)).slice(0,16)`,
     adjust if create rejects it (risk R2).
  3. answer server-directed requests per the table above
  4. `session/subscribe` `{sessionId, deliveryKind:'desktop-continuous'}`
  5. `session/send` `{sessionId, content, modelSelection:{providerId:'zai-api',
     modelId, options:{reasoningLevel}}}`
  6. stream `model.streaming` deltas to stdout (plain mode) or emit as NDJSON
     events (`--json`); the `model_request_started` telemetry event carries
     engine-reported `providerId`/`modelId` — recorded into the result line
     (engine-reported, not a wrapper echo)
  7. completion = computer-use/operation-event `turn-completed` or telemetry
     `turn.terminal` status `success|failed`; final assistant text = the final
     session/event `payload.content` (deltas are display-only; the final
     payload is authoritative)
  8. for `agent`: `session/subagents` → `{running:[…], ended:{items:[…]}}`
     (schema W5i, research: `subagentMechanism`)
  9. SIGKILL child, drain, exit per §10 codes.
- Per-request timeout 15 s for create (matches engine), overall run timeout
  `--timeout-ms` (default 600000) → kill + exit 124.

### 9.1 Mode & permissions (why subagent tool calls don't hang)

A bare `session/create` (no mode param) yields session `mode:"build"`
(review-verified), and a subagent that writes files will trip
`interaction/requestPermission` — in `build` mode that means an unanswered
request, a 15 s stall, or a de-facto deny. Strategy, in order:

1. **Primary: run everything in `yolo` mode** — the engine's own headless
   default (`--mode` help text: "build, edit, plan, or yolo (default: yolo for
   --prompt)", research: `headlessUsage`). Pass `mode:'yolo'` in
   `session/create` params and **verify** the echoed `result.session.mode`;
   if the param is not honored, call `session/setMode` (exists — 2 bundle
   occurrences, confirmed this session) and re-verify. The run command
   records the achieved mode in its `--json` result line; the agent test
   asserts it (§12 step 6), so the permission path is gated by a live test,
   not assumed.
2. **Defense-in-depth: answer `interaction/requestPermission` with allow.**
   The exact allow-result schema is unknown (never captured live); the
   Builder pins it from the first live occurrence while writing step 6 —
   e.g. by running step 6 once with mode intentionally left at `build`. If a
   permission request arrives and cannot be shaped, fail loudly (exit 5, raw
   request dumped — it contains no key material) rather than silently
   denying.
3. **Safety boundary = `--cwd`.** Yolo auto-approves tool side effects; that
   is the product's intent (a scripting agent), and the workspace the session
   can touch is the directory the user explicitly points at. Tests use a
   throwaway temp dir.

---

## 10. CLI surface

```
zai-code [prompt…]                     one-shot turn (prompt from argv or stdin)
zai-code -p, --prompt <text>           same (familiarity alias)
zai-code agent [--profile <name>] <instructions…>
                                       turn that MUST dispatch an Agent-tool
                                       subagent; verified, not trusted (§11)
zai-code login                         read API key from stdin (no echo) →
                                       ~/.zai-code/credentials.json (600)
zai-code doctor [--json] [--fresh]     engine + isolation + key report;
                                       never prints the key; warns when the
                                       spawning node major < 26 (R11)

Options:
  --model <id>      glm-5.3 | glm-5.3-flash (+aliases, §7). Default: glm-5.3-flash
  --effort <level>  low|medium|high|xhigh|max. Default: max
  --cwd <dir>       workspace for the session (default: process.cwd())
  --json            NDJSON events on stdout; final line {"type":"result",…}
  --timeout-ms <n>  default 600000
  --fresh           rebuild the scratch HOME first
  --version, --help
```

Exit codes: `0` success · `1` unexpected internal error · `2` usage / unknown
model · `3` no API key · `4` engine or builtin config not found · `5` turn
failed (engine error event, `turn.terminal` failed, unanswerable user-input
request, or create/subscribe/send error) · `6` `agent`: no subagent dispatched
or none ended `success` · `124` timeout.

All sessions run in `yolo` mode (§9.1). `--json` final result line contract
(stable for scripts):

```json
{"type":"result","ok":true,"response":"…","model":"GLM-5.3-Flash",
 "effort":"max","mode":"yolo","sessionId":"sess_…",
 "usage":{"inputTokens":19608,"outputTokens":3},
 "subagents":[…only for agent…],"durationMs":21972}
```

---

## 11. Subagent surface

Mechanism (research: `subagentMechanism`): subagents are launched by the MODEL
calling the in-session `Agent` tool during a headless run — v0.16.9 has NO CLI
flag for it (no `--agent`; verified against `--help`, run both by the
researcher and again this session). Each spawned agent writes
`$HOME/.zcode/cli/agents/<parent_sess>/agent_<uuid>/metadata.json` +
`output.txt` under the scratch HOME (which we own), and the
`session/subagents` RPC reports `{running:[status running|waiting|blocked],
ended:{items:[status success|failed|cancelled|lost]}}`.

Profile resolution, stated honestly: `general-purpose` — the profile the test
uses — resolves from the engine's **built-in** profiles (review: real
`metadata.json` shows `profileSnapshot.source:"built-in"`), so it works with
an empty agents dir. The copied `~/.zcode/agents/*.md` (§6.2 item 4) exists so
USER-defined custom profiles still resolve under the scratch HOME; that
copied-profile path is **not** gated by the test suite (risk R4) and is
documented as such. Runs needing a custom profile pass `--profile <name>`.

`zai-code agent` therefore:

1. Wraps the user's instructions in a dispatch-forcing preamble: "You MUST use
   the Agent tool (profileId: `<profile>`, default `general-purpose`) to
   accomplish the task; do not do the work yourself; report the result."
2. Runs the normal §9 sequence in `yolo` mode (§9.1) on Flash (default) with
   effort max.
3. After turn completion, verifies programmatically — never trusts the prose:
   calls `session/subagents` and joins `ended.items` with the scratch agents
   dir (`metadata.json`: agentId, childSessionId, profileId, status,
   totalDurationMs, usage; `output.txt`: the subagent's report).
4. Emits `result.subagents[]` (see §10) and exits 0 **iff** parent turn
   succeeded AND ≥1 subagent ended `success`; else exit 6 with the reasons.

This is trivially scriptable, e.g.:
`zai-code agent --json --cwd $WORK "create note.txt containing HELLO" | tail -1 | jq .subagents`

---

## 12. TDD plan (functional only; every step RED before GREEN)

Runner: `node --test test/`. No mocks anywhere; every test drives the real
`bin/zai-code.js` as a child process against the real engine, and tests 4–7
hit the real GLM API through the isolated scratch HOME. Shared helper
(infrastructure, not a test): `test/helpers/env.js` — loads `.env`'s `API-KEY`
(line-parsed, never printed), fails fast with a clear message if engine or key
is missing, exposes `cli(args, {env, timeoutMs})`.

**Determinism policy for live-model assertions** (applies to steps 4, 5, 7):
assistant-text assertions compare `response.trim()` (no byte-exact raw
compare); each API test has a retry budget of ONE fresh session for (a)
trimmed-content mismatch, (b) `turn.terminal` failed, or (c) transport
timeout; hard config errors (exit 2/3/4) are never retried. Wire-level facts
are asserted from engine-side artifacts (telemetry events, rollout request
bodies), never from the wrapper's own echo of what it sent.

Builder step 0 (setup, not TDD): `package.json` per §3, `bin/`+`lib/`
skeletons that do nothing yet, `LICENSE` (MIT), `README.md` stub,
`.gitignore` containing `.env`, `.DS_Store`, `node_modules/`. Then, strictly
in order:

1. **Allowlist rejection.** RED: `test/allowlist.test.js` —
   `cli(['--model','gpt-4o','hi'])` and `cli(['--model','GLM-4.6','hi'])` (a
   realistic mistake — GLM-4.6 exists in the user's legacy provider config,
   verified this session) exit 2 with stderr naming `glm-5.3` and
   `glm-5.3-flash`. No API call (rejection precedes spawn — inherent, not a
   mock). GREEN: argv parsing + `lib/models.js` allowlist.
2. **Missing key.** RED: `test/missing-key.test.js` — with
   `ZAI_CODE_HOME=<tmp>` and `ZAI_API_KEY=''`, `cli(['hi'])` exits 3, message
   mentions `zai-code login` and `ZAI_API_KEY`. GREEN: `lib/key.js`.
3. **Doctor builds isolation; live config untouched.** RED:
   `test/doctor.test.js` — `cli(['doctor','--json','--fresh'])` exits 0; JSON
   asserts engine path exists, builtin config exists, scratch
   `home/.zcode/v2/provider_config.json` exists with mode ≤600 and exactly the
   zai-api rule whose key sha256 equals the loaded key's sha256 and (when a
   live v2 exists) differs from the live key's sha256, and **no
   `credentials.json` in the scratch**; **and** `stat` mtimes of live
   `~/.zcode/v2/provider_config.json` + `~/.zcode/cli/config.json` are
   identical before/after (scoped to these two files per §6.4 — the desktop
   app's own log/db writes are out of scope). GREEN: `lib/engine.js` +
   `lib/isolation.js` (recipe §6.2, fallback ladder if needed).
4. **REAL API — Flash one-shot (the big one).** RED:
   `test/run-flash.test.js` —
   `cli(['--json','Reply with exactly the word OK and nothing else.'])` exits
   0; final NDJSON line: `response.trim() === 'OK'`, `model ===
   'GLM-5.3-Flash'` **cross-checked against the engine-reported
   `model_request_started` telemetry event** (engine-reported, not the
   wrapper's echo), `effort === 'max'`, `sessionId` matches `/^sess_/`,
   `mode === 'yolo'`, `usage.outputTokens > 0`; stream contained ≥1
   `model.streaming` event. GREEN: `lib/appserver.js` + `run` command (§9
   sequence incl. the runtime-preferences answer, both effort wire locations,
   and the §9.1 mode ladder). If registration fails here, walk the §6.2
   fallback ladder — this test is the arbiter.
5. **REAL API — effort flag, verified on the wire.** RED:
   `test/effort-flag.test.js` —
   `cli(['--effort','high','--json','Reply with exactly the word OK and
   nothing else.'])` (Flash) → trimmed response OK, and **the effort
   assertion reads the scratch HOME's rollout request capture for the run's
   sessionId** (`.request.body` files — the same mechanism the research used:
   "Rollout (scratch): .request.body = {model:'GLM-5.3-Flash',
   thinking:{type:'enabled'}, max_tokens:128000}"), asserting the captured
   body reflects `high` per the field name the Builder pins from this first
   live capture; the wrapper's `effort` echo is secondary only. If — and only
   if — the captured body provably carries no level field at this engine
   version, the test asserts the body's model id + `thinking` enabled,
   records that fact here in DESIGN.md, and the echo check stands as the
   level evidence. GREEN: effort flag wiring.
6. **REAL API — subagent does real work, inside cwd, yolo-gated.** RED:
   `test/agent.test.js` — create a throwaway workdir, run
   `cli(['agent','--json','--cwd',WORK,'--profile','general-purpose', 'Use
   the Agent tool to create the file hello.txt in the current directory
   containing exactly HELLO-SUBAGENT, then report the agent id.'])` → exit 0;
   `result.mode === 'yolo'` (gates §9.1); `result.subagents.length ≥ 1`, all
   listed `status === 'success'`; `<WORK>/hello.txt` exists with exactly
   `HELLO-SUBAGENT` (artifact inside the session cwd — no out-of-cwd writes);
   parent `response` non-empty. While writing this test, the Builder also
   captures one live `interaction/requestPermission` frame (§9.1 item 2) and
   pins the allow-answer schema. GREEN: `agent` command + subagents RPC +
   agents-dir join + exit-6 semantics.
7. **REAL API — the single GLM-5.3 acceptance run.** RED:
   `test/glm53-acceptance.test.js` —
   `cli(['--model','glm-5.3','--json','Reply with exactly the word OK and
   nothing else.'])` → exit 0, `response.trim() === 'OK'`, `model ===
   'GLM-5.3'` cross-checked against the `model_request_started` telemetry
   event. GREEN: expected to pass with zero new code (allowlist already maps
   it); if it fails, fix mapping or the §6.2 copy for GLM-5.3. This is the
   ONLY test that may run GLM-5.3.
8. **Packaging guard.** RED: `test/pack.test.js` — `npm pack --dry-run --json`
   lists only `bin/`, `lib/`, `README.md`, `LICENSE`, `package.json` and does
   NOT contain `.env`, `test/`, or `DESIGN.md`. GREEN: `files` allowlist +
   LICENSE (offline test, but it guards a real security property: the repo
   contains `.env` with a live key).

Tally: 8 tests, 4 hitting the real API — 3 on Flash (steps 4, 5, 6), exactly 1
on GLM-5.3 (step 7). No mocks, no unit tests of internals; every test is a
user-visible behavior.

---

## 13. Packaging & publish checklist

- `package.json`: name/bin/engines/files/dependencies per §3;
  `"scripts":{"test":"node --test test/"}`; `"license":"MIT"`;
  `"private": false`.
- README: quickstart (login → run → agent), the two allowed models, default
  effort max, yolo-mode + `--cwd` safety-boundary explanation, isolation
  explanation (why we never touch `~/.zcode`, and that the user's OAuth
  `credentials.json` is deliberately never copied), engine requirements
  (macOS app bundle today; `ZAI_CODE_ENGINE` for other layouts; node ≥ 26
  recommended, `ZAI_CODE_NODE` override), exit codes, `--json` contract.
- Pre-publish: re-run `npm view zai-code version` (availability verified
  2026-09-30, may change); `npm pack --dry-run` inspect; full suite green;
  `npm publish` (public).
- No prepublishOnly hook — the `files` allowlist + step-8 test are the guard.

---

## 14. Risks & mitigations

- **R1 — Selective v2 copy may miss a registration file.** Mitigated heavily:
  the review live-proved Tier (a) (top-level files, no `credentials.json`, no
  dirs) registers `zai-api/GLM-5.3-Flash` (`sess_22…`). Residual risk is
  engine drift. *Mitigation:* §6.2 fallback ladder (never re-adding
  `credentials.json`), arbitrated by the live step-4 test; `doctor` reports
  the tier.
- **R2 — `workspaceKey` semantics unknown** (live proof passed an unspecified
  value). *Mitigation:* deterministic sha256-of-realpath; adjust on create
  rejection; step-4 test catches it immediately.
- **R3 — Undocumented internal protocol can drift** (v0.16.9 bundle; desktop
  updates can change the wire silently). Five server-directed methods are now
  known and handled with per-method policies (§9 table); one of them
  (`interaction/requestOfficialMcpAuthHeaders`) is proven non-fatal when
  unanswered (review). *Mitigation:* doctor prints engine version + sha256;
  `ZAI_CODE_ENGINE` pins a known copy; unknown server requests get -32601;
  suite fails loudly on drift.
- **R4 — Custom (user-defined) agent-profile resolution under scratch HOME is
  untested.** `general-purpose` is built-in (review: `profileSnapshot.source:
  "built-in"`), so the tested path does not exercise the copied
  `agents/*.md`. *Mitigation:* copy is cheap and harmless; README documents
  that custom profiles depend on the copy; if a user reports a custom profile
  not found, the fix is one live reproduction, not a redesign.
- **R5 — Effort levels beyond `low/high/max` may be rejected per-model**
  (GLM-5.3's level set never observed live; Flash observed `[low,high,max]`).
  *Mitigation:* default is `max` (safe on both — the user's own logs show max
  on both models); engine errors surface verbatim with exit 5.
- **R6 — Key must transitively exist in a scratch file** (engine requirement;
  env fallback insufficient — proven). *Mitigation:* mode 600 under mode-700
  `~/.zai-code/home/`, never printed/logged/committed; pack test guarantees it
  never ships; `login` and `ZAI_API_KEY` keep it out of shell history; the
  user's OAuth `credentials.json` is excluded from the scratch entirely
  (review-proven unnecessary).
- **R7 — Fresh-machine synthesized-config path is unproven.** *Mitigation:*
  marked experimental; doctor reports `isolationMode`; needs one clean-HOME
  verification before being advertised.
- **R8 — Copied desktop state could expose account providers in the scratch
  registry.** Now structurally defused: with `credentials.json` excluded, the
  OAuth account providers have no tokens in the scratch and cannot
  authenticate; imported:* rules are pruned; and the wrapper only ever writes
  `zai-api` ids into requests (§7). Residual: cosmetic registry entries.
- **R9 — 15 s create timeout if `requestRuntimePreferences` goes unanswered.**
  *Mitigation:* the client answers it by design (§9); step-4 test would fail
  deterministically if the answer path breaks.
- **R10 — Slow first run** (v2 top-level copy + engine spawn). *Mitigation:*
  one-time build cached with mtime stamp; subsequent runs are engine-spawn
  only; `--fresh` for explicit rebuilds.
- **R11 — Engine spawn under node < 26 is untested** (engine has only ever
  run under v26.5.0; the wrapper's `engines >= 20` says nothing about the
  engine child). *Mitigation:* `doctor` warns when the spawning node major is
  < 26; `ZAI_CODE_NODE` points the engine at a newer interpreter; README
  states node ≥ 26 recommended. Optionally verify once on node 20 before
  widening the claim.
- **R12 — Yolo mode auto-approves tool side effects.** Intentional (scripting
  agent; mirrors the engine's own `-p` default). *Mitigation:* `--cwd` is the
  declared blast radius and is documented as such; all tests use throwaway
  temp dirs.
- **R13 — Exact `interaction/requestPermission` allow-schema is unknown**
  (never captured live). *Mitigation:* primary strategy (yolo mode) avoids the
  path; the Builder captures one live frame while writing step 6 (§9.1); on
  unshapeable requests the client fails loudly (exit 5) instead of silently
  denying.

---

## 15. Evidence appendix (verified in THIS design session)

Run by me:

- Repo state: `ls -la /Users/george/Workspace/Z-code-cli` → `.env` (59 B) +
  `.zcode/` (workflow drafts/runs) only.
- Key present, never printed: `grep -c '^API-KEY=' .env` → 1.
- Node: v26.5.0 at `/opt/homebrew/bin/node`.
- Engine exists: `/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs`
  (14.8 MB, 755); version 0.16.9 via `--help` and `version` (both run here);
  `app-server` subcommand listed in help.
- Protocol methods in the bundle (`grep -o <pat> zcode.cjs | wc -l`):
  `session/setMode` → 2, `interaction/requestPermission` → 1,
  `interaction/requestUserInput` → 1, `interaction/requestOfficialMcpAuthHeaders`
  → 1, `session/requestRuntimePreferences` → 1, `pendingPermissions` → 5.
- Builtin provider config exists:
  `…/Resources/config/provider/zcode-builtin.json` (182 KB).
- Engine NOT on PATH; `~/.zcode/runtime` and `~/.local/bin/zcode` absent →
  app bundle is the only resolvable engine here.
- `~/.zcode/v2/provider_config.json` (mode 600): rule[0] is exactly the
  zai-api standard-personal api-key rule (key present); two `imported:*` rules
  with third-party keys — pruned in our copy.
- `~/.zcode/cli/config.json`: keys `provider|model|plugins|mcp`;
  `builtin:zai` provider (kind anthropic, baseURL
  `https://api.z.ai/api/anthropic`, key present, legacy glm-4.x/5.x model
  list).
- Agent profiles present: `~/.zcode/agents/*.md` (generalglm,
  implementation-worker, vision, flash, …) + tool-proxy subdirs;
  `~/.zcode/bundled-agents/` = tarballs + manifest only.
- v2 size: 1.2 G total (logs 174M, sessions 33M) → selective copy forced.
- npm availability: `npm view <name> version` on 2026-09-30 → `zai-code`
  AVAILABLE (E404), `zai-cli` TAKEN (1.1.0), `zai` TAKEN (1.0.0),
  `zcode-glm` AVAILABLE (fallback).

Run by the design reviewer (reported in the review; not re-run by me):

- Tier-(a) isolation copy WITHOUT `credentials.json` (and without `certs/`,
  `runtime/`, `agent-config/`) still registers `zai-api/GLM-5.3-Flash`:
  `session/create` → `sess_22…` with `result.session.model` echoed.
- Bare `session/create` (no mode param) → session `mode:"build"`.
- `interaction/requestOfficialMcpAuthHeaders` arrived during a run, was left
  unanswered, and `session/create` still succeeded (validates the generic
  -32601/ignore policy for non-critical server requests).
- Real subagent `metadata.json` shows `profileSnapshot.source:"built-in"` for
  profileId `general-purpose`.
- Live `~/.zcode` concurrent desktop-app writes during a 45 s window:
  `cli/log/zcode-2026-09-30.jsonl` (+~18 KB), `v2/logs/2026-09-30.log`
  (+2.4 KB), `cli/db/db.sqlite-wal` bumped — while the scratch-HOME engine
  child wrote only under scratch; the two asserted config files were
  untouched.
- Live `credentials.json`: 88 KB, mode 600, mtime today 19:14 (actively
  rewritten by the running desktop app) — excluded from our copy.

Everything else (wire sequence, isolation proof, model registration layers,
effort plumbing, subagent mechanism) is cited from the app-research bundle
supplied with the ask, whose live-verification section reports a real
GLM-5.3-Flash completion through exactly this path.

---

## 16. Builder findings (live-pinned during the TDD build, 2026-09-30)

Corrections and confirmations discovered while making steps 4–8 green; every
item below was observed on the wire during this build:

- **Effort field on the wire is `request.body.output_config.effort`** in the
  engine's rollout capture (`~/.zai-code/home/.zcode/cli/rollout/model-io-<sessionId>.jsonl`,
  one `type:"model_io"` record per model request). A `max` run captured
  `{"output_config":{"effort":"max"}}`, a `high` run
  `{"output_config":{"effort":"high"}}`; both bodies also carry
  `thinking:{type:"enabled"}` and `max_tokens:128000`. The §12-step-5 escape
  hatch ("body provably carries no level field") was NOT needed — the level
  is on the wire, just under `output_config`, not `thinking`.
- **`session/create` does NOT honor a `mode` param** (result came back
  `mode:"build"` with `mode:'yolo'` sent) — the §9.1 `session/setMode`
  `{sessionId, mode:'yolo'}` fallback is mandatory, and works: the engine
  broadcast `state.updated` with `patch.mode.current:"yolo"`, and the same
  patch shows `thoughtLevel.current:"max"` and
  `model.current.options.reasoningLevel:"max"`.
- **Session id field is `result.session.sessionId`** (not `.id`).
- **Completion frame is `session/event` with `params.type:"turn.completed"`**
  and the authoritative final text at `params.payload.response` (not
  `payload.content`); usage at `params.payload.usage`. Corroborating
  terminal signals: `computer-use/operation-event` `kind:"turn-completed"`
  and `v4/telemetry/event` `kind:"turn.terminal"` (`status:"success"`).
- **Streaming frames are `session/event` with `params.type:"model.streaming"`**,
  payload `{delta, kind:"reasoning_delta"|"text_delta", done}`.
- **Engine-reported model evidence** rides on `session/event`
  `params.type:"session.updated"` with `payload.type:"model_request_started"`
  carrying `{providerId, modelId, modelCall.reasoning.requestedLevel}`.
- **Server-directed request ids are strings** (`"server-2"`, `"server-4"`);
  answers must repeat their id. `session/requestRuntimePreferences` arrived
  twice per run; `interaction/requestOfficialMcpAuthHeaders` arrived and a
  `-32601` answer was again non-fatal.
- **One live `interaction/requestPermission` frame was captured** (step 6,
  build-mode probe): params `{input, reason, requestId, riskLevel,
  sessionId, options:[{kind:"allow"|"allow-always"|"addRules"|"deny",
  optionId, response:{decision, reason}, …}], toolCallId, toolName,
  turnId}`. Its own options block confirms the answer schema
  `{decision:"allow", reason}` — matching the bundle's headless broker,
  which returns `{decision:"allow", reason, resolvedAt}` (resolvedAt
  optional). The client answers exactly that. Caveat observed: an answer
  sent TWICE for the same request id makes the engine fail the tool call
  with "Permission request failed" — one answer per request id (the probe
  bug that revealed this was a duplicated readline, not client behavior).
- **Yolo-mode subagent runs produce ZERO permission requests** (0 frames in
  the successful step-6-style run) — the §9.1 primary strategy holds; the
  allow-answer path remains defense in depth.
- **`session/subagents` shape**:
  `{revision, childSessionIds, running:[], ended:{total, items:[{
  childSessionId, agentId, toolCallId, subagentType, title, startedAt,
  endedAt, status, summary}]}}`. IMPORTANT: `status:"success"` means the
  subagent RETURNED, not that its work succeeded — a build-mode subagent
  that failed every write still ended `status:"success"` with a failure
  summary. The artifact check (hello.txt content) is the real gate, as
  §12 step 6 specified.
- **Subagent artifacts** at `<scratch>/.zcode/cli/agents/<parent_sess>/
  agent_<uuid>/{metadata.json,output.txt}`; metadata includes `agentId`,
  `childSessionId`, `profileId`, `profileSnapshot.source` (`"built-in"` for
  general-purpose, reconfirmed live).
- **hello.txt came back byte-exact** (`HELLO-SUBAGENT`, 14 bytes, no
  trailing newline) — the subagent rewrote the file to satisfy "exactly".
- Test runner note: on node v26.5.0 `node --test test/` (directory arg) is
  treated as a module path and fails; the npm script uses node's own glob
  `node --test --test-concurrency=1 "test/**/*.test.js"` (concurrency 1
  because `doctor --fresh` rebuilds the shared scratch HOME and must not
  race a live engine child, and because the live tests share one API key).

---

## 17. 0.4 — executor redesign (orchestrator-facing)

Goal: zcode as a lean execution engine an orchestrator (Opus, Sonnet, GPT, …)
invokes at any task size, with independent sessions, zcode-run
verification and a structured handback, entirely through the CLI.

**Defects fixed (found by inspection, 0.3.2):**

- *Shared scratch HOME destroyed sessions.* `ensureIsolation` stamped the
  mtimes of every live v2 file, including ones the desktop app rewrites
  constantly (`agents-state.json`, `bot-config.v3.json`, …). Any change
  triggered `rm -rf <root>/home`, which deleted the engine's session DB
  (`cli/db/db.sqlite`) under every other invocation, broke `--session`
  resume, and could pull the HOME out from under a running engine.
- *Per-run overlays raced.* `--mcp` rewrote the shared `cli/config.json`
  and `--skills` / `--no-skills` rewrote the shared skills dir while other
  runs' engines were reading them.
- *Engine death mid-turn waited for the full timeout.* `onExit` was never
  wired into the turn.
- *Cancellation was a bare SIGKILL.* The engine was never told to stop.
- *The plain feed wrote reasoning one character per `write()`.*

**Architecture (smallest change that supports the executor workflow):**

| module | responsibility |
|---|---|
| `lib/isolation.js` | one engine HOME per session (`<root>/sessions/<id>/home`); config rewritten in place on every invocation; engine state never deleted; plugin/runtime caches shared via symlink |
| `lib/store.js` | session record (atomic writes), bounded events log, `result.json`; `interrupted` = active state with dead pid |
| `lib/workspace.js` | ownership patterns, overlap check, leases (write-then-read with deterministic back-off), git/fs change snapshots |
| `lib/contract.js` | task contract normalization, executor protocol prompt, handback parsing, the single `deriveStatus` |
| `lib/checks.js` | zcode-run acceptance checks: process group, timeout, abort, bounded tail, `CI=1` |
| `lib/appserver.js` | `openSession` (side-effect free, retryable) + `runTurn` (one prompt; `session/stop` on timeout/cancel/user-input) |
| `lib/executor.js` | the one lifecycle every turn command uses |
| `lib/commands/exec.js`, `sessions.js` | CLI surfaces: run/task/agent/resume/detach; status/wait/cancel |

`session/stop {sessionId}` was confirmed by static inspection of the 0.16.x
bundle (`wci` handler aborts `activeAbortController`). It has not been
exercised live by this build.

**Invariants added:** a prompt that reached the engine is never re-sent
automatically, and only `openSession` is retried; an existing session id
is never re-run; status is derived from zcode's own evidence (checks, diff,
scope), never from the model's claim alone; leases refuse overlapping
ownership unless `--allow-overlap` is passed.

**Test split:** `npm test` is now the in-process unit suite (a scripted fake
engine in `test/fixtures/fake-engine.js`; no CLI spawn, no API).
`npm run test:live` is the previous functional suite, adapted to the
per-session layout.

## 18. 0.5 — quiet orchestration

Goal: an orchestrator spends tokens only on decisions; parallel sessions
never collide. Measured by `scripts/measure.js` against `docs/baseline.json`
(recorded on 0.4.4 before any 0.5 change): result line, `wait` timeout
output, executor prompt, wall time. Gates: result <= 20% of baseline;
wait timeout <= 120 B per pending session; prompt <= baseline plus the
always-on new sections (<= 400 B); wall time <= baseline + 5% (+300 ms).

### 18.1 Quiet output (phase 1)

- `lib/brief.js` projects the full record (`zcode.result/1`, unchanged,
  always what `result.json` holds) to the brief (`zcode.brief/1`): status,
  ok, id, label, summary (<= 600), files (paths), checks (passing =
  `{command, ok}`; failing adds exitCode/timedOut/tail <= 1500), questions,
  issues, unresolved, scopeViolations, touched, decisions, visual, units,
  error (`{kind, message <= 500}`; `checks_failed` is kind only, the
  failing checks are listed), `result` path. Empty keys omitted. run/agent
  add `response`. `--json` prints the brief; `--full` the full record.
- `zcode result <id> [--json] [--full]`: handback of a finished session
  (exit 7 while running).
- `wait`: on timeout one line per pending session
  (`{"type":"pending",id,state,phase,elapsedMs}` / `id state phase 12m`),
  exit 124. `--any` returns the first finished session (its exit code).
- Usage errors are one line with a did-you-mean for unknown flags; the help
  text is only printed by `--help`.

### 18.2 Effort validation before spawn (phase 2)

`lib/models.js` reads the supported reasoning levels per model from the
engine's builtin provider config (`modelConfigRules.modelRules[]`; the last
matching rule that lists `reasoningLevel.values` wins; both GLM-5.3 and
GLM-5.3-Flash list `low|high|max`), with a built-in fallback table.
`exec.js` checks the final model+effort pair (flag, contract, or a resumed
session's settings) before any session record or engine exists: exit 2,
one line. `doctor --json` reports `models: {id: [levels]}`. `medium` and
`xhigh` stay in the effort enum (so the message can say they are
unsupported) but are refused for both models.

### 18.3 Parallel-safe sessions (phase 3)

- `lib/ports.js`: `reservePort` takes a pid lock file per port under
  `<root>/ports/` (range 41000-48999, a resumed session prefers its previous
  port) and verifies with a real bind probe, so the port is unique among
  live sessions and also free of foreign listeners. Released with the
  session.
- Environment for executor and checks (`engineEnv(sessionEnv)`,
  `runChecks({env})`): `ZCODE_SESSION_ID`, `ZCODE_PORT`, `ZCODE_OUT`
  (`<cwd>/.zcode/out/<id>`), `ZCODE_TMP` (`<root>/sessions/<id>/tmp`);
  recorded in the session record (`port`, `out`, `tmp`) and the full result
  (`sessionEnv`). The prompt gets a "Session environment" section built by
  `contract.sessionSection` (<= 400 bytes; it is the one always-on addition
  budgeted in `scripts/measure.js`).
- Any path with a `.zcode` segment is skipped by `snapshot` (git mode) and
  filtered from the diff, including committed changes.
- `--touch` / contract `touch`: stored as `inv.touch` (workspace-relative
  patterns, like owns). Changed unowned files matching a touch pattern are
  `touched` (result `touched`, `changes.files[].touched`), never scope
  violations. `acquireLease({touch})` refuses (exit 7, message in the owns
  style) when a live lease overlaps a touch pattern; leases record `touch`
  but it is never compared against other sessions' ownership.

### 18.4 Decisions stay with the orchestrator (phase 4)

- `lib/taskspec.js` `buildContract({base, baseDir, objective, additions, cwd})`
  is the one place a contract is assembled from its sources (used by
  `zcode task`; `scripts/measure.js` builds its prompt through it, and plan
  files reuse it). It inlines `@file` entries of `context` and `decisions`
  (flags: relative to the process cwd; contract JSON: relative to the contract
  file's directory), drops a `files` entry that resolves to an inlined file,
  runs `normalizeContract` (identical `context`/`acceptance`/`files`/
  `decisions` entries deduped) and validates units. It throws
  `ContractError`; `exec.js` turns that into a one-line exit 2.
- Contract keys added: `decisions`, `units`, `visual`, `viewports`, `serve`.
  `decisions` and the older `design` render in one section, "Binding
  decisions (made by the orchestrator: implement exactly)".
- Protocol: a "do not guess" bullet (blocked + structured question, or the
  conservative choice listed in `decisions`) and handback `decisions:
  [{what, why}]`. A question is a string or `{q, options?, recommend?}`
  (`parseHandback` keeps both shapes; `contract.questionText` renders them).
  These always-on lines are budgeted separately in `scripts/measure.js`
  (`PROTOCOL_ALLOWANCE`, 400 bytes); the measure gate "bare prompt <= baseline"
  therefore became "<= baseline + 400".
- `--preflight` (`inv.preflight`, setting + session record `preflight`): the
  prompt gets a read-only "Preflight" section and no checks section; no lease
  is taken; after the handback the loop stops (no checks). `deriveStatus`
  yields `blocked` (status blocked or any question), `completed` (summary
  forced to "no open questions") or, if any non-concurrent file changed,
  `failed` with `error.kind = preflight_wrote`. Resuming a session whose
  settings say preflight clears the flag (settings + record) and sends the
  full task prompt plus an "Answers to your preflight questions" section.

### 18.5 Units (phase 5)

`--unit "name: objective [owns a,b]"` / contract `units` -> `contract.units`
(`parseUnit`, `normalizeUnits`: unique names, objective required). Owns are
validated in `taskspec.validateUnits` after normalising like `--owns`:
inside the session owns (`isOwned`) and pairwise disjoint (`ownsOverlap`,
units without owns are not compared); violations exit 2. The "Units" prompt
section tells the executor to dispatch one subagent per unit. Handback
`units` goes to the result/brief and, as executor claims, into `notVerified`.

### 18.6 Visual verification (phase 6)

`--visual` / `--viewport` / `--serve` -> contract `visual`, `viewports`,
`serve`; the "Visual verification" section renders only when `visual` is
non-empty (viewports default to `390x844`, `1440x900`; screenshots go to
`$ZCODE_OUT/shots`, the server to `$ZCODE_PORT`). The executor loop now
continues past the checks stage whenever checks or visual criteria exist:
`unmetVisual(handback, declared)` (entries without `met: true`, or all
criteria when `visual` is not reported) and failing checks share the repair
budget and one combined repair prompt (`buildRepairPrompt(..., {visual})`).
After the budget `deriveStatus` returns `partial` with `visual criteria
unmet: ...` (failing checks still win with `failed`). The results are noted
in `notVerified` as executor judgement; zcode does no pixel check.

### 18.7 Plans (phase 7)

`zcode plan` (`lib/plan.js` logic, `lib/commands/plan.js` CLI) runs a DAG of
task sessions from one file.

```
plan.json = { "cwd"?, "decisions"?, "context"?, "files"?, "model"?, "effort"?,
              "sessions": [ { "id", "after"?: [ids], ...task contract keys } ] }
```

`cwd` is relative to the plan file (an explicit `--cwd` wins); `decisions` and
`context` entries starting with `@` are files relative to the plan file. Per
session the contract is `{top-level decisions/context/files first, then the
session's own}`, the plan's `model`/`effort` as defaults, assembled by
`taskspec.buildContract` (`sessionBase`). Session ids are zcode session ids
verbatim. The plan name is `--id` or the file's basename.

- **check** (`checkPlan`, also run by `run`): one line per problem, exit 2.
  Unknown plan keys, empty or malformed `sessions`, invalid/duplicate ids (and
  `<id>.pre` must fit 64 chars), `after` refs that do not exist or point at
  the session itself, dependency cycles, contract errors (units, `@file`,
  unknown keys), model/effort via `models.effortProblem`, and ownership: two
  sessions that can run at the same time (neither transitively `after` the
  other) must own disjoint paths (`ownsOverlap`; no owns = whole workspace).
  An id that already exists as a session is refused unless the stored plan
  state of that name lists it, so a plan is continued with `plan resume`.
- **State.** `<root>/plans/<name>.json` (`schema: zcode.plan-state/1`):
  `{name, file, cwd, sessions, supervisor: {pid}|null, launchErrors}`,
  created exclusively (a second `plan run` of a name exits 7). Progress is
  never stored: a session's status is its record's (`queued`, `running`,
  `interrupted`, or the finished status). A session with no record is
  `pending`, or `skipped` when anything it is transitively `after` ended
  without `completed`; a launch that failed before a record existed reads
  `failed` (`launchErrors`). The plan status is derived: `running` (live
  session, or pending with a live supervisor), `completed`, `blocked`
  (any blocked), `failed` (failed/cancelled/interrupted), `partial`
  (otherwise), `interrupted` (pending work but the supervisor is dead).
  Exit codes: 0 completed, 10 blocked, 8 any other non-running, 124 timeout.
  So `status`/`wait` stay accurate when the supervisor dies.
- **Supervisor** (`supervise`): holds a pid lock (`plans/<name>.lock`), polls
  the sessions every 500 ms, launches each pending session whose `after` all
  `completed` through `exec.startDetached` (the extracted core of `--detach`;
  `buildInvocation(parsed, {base, dir})` takes the assembled contract in place
  of `--task`), and stops when nothing is live or pending. Skipped sessions
  need no marking (derived). `plan run` supervises in-process; with
  `--detach` it spawns `zcode __plan <name>` and prints
  `{"type":"plan","name","status":"running"}`. A `--timeout-ms` expiry hands
  supervision to a detached supervisor, prints the pending summary, exit 124.
- **wait/status**: exactly one JSON line
  `{type:"plan",name,status,sessions:[{id,status}],briefs:[…]}`, `briefs` =
  `zcode.brief/1` of every finished session that is not `completed`; on a
  timeout the same line without `briefs`, `status:"running"`, exit 124.
  Human output is one line per session (`id status - summary`, blocked
  sessions list their questions). `status` exits 0; `wait` returns once the
  status is not `running` (also `interrupted`).
- **resume** (`plan resume <name> [message…] [--session id]`): resumes every
  failed/partial/unverified/blocked/cancelled/interrupted session through
  `buildResume` + `startDetached` (default message "Continue: fix the
  remaining issues."; blocked sessions need a message, else exit 2), then
  restarts supervision. Skipped sessions need no action: once their upstream
  runs again they are pending and the supervisor launches them when it
  completes.
- **preflight** (`plan run --preflight`): every session as a read-only
  preflight named `<id>.pre` (previous `.pre` sessions are deleted first;
  `after` is ignored, preflight takes no lease so no ownership conflicts),
  waiting for all (`--timeout-ms`, default 10 min), then one brief per session
  with questions (exit 10; failed ones are printed too, exit 8), or, with
  none, one line `{type:"preflight",name,status:"completed",sessions:N}`.
  No plan state is created, so a later `plan run` is unaffected.

`usage()` in exec.js now throws `UsageError` (turned into the one-line exit 2
at the command entry) so the builders can run inside the supervisor.

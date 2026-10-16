# Changelog

## 0.6.0

Independent visual verification and live progress, from a real run whose hero headline was invisible while the executor reported it visible: GLM-5.3 cannot see images (reading a PNG returns only an upload confirmation), so it judged from the DOM, and it graded its own work.

### Added

- `supportsImage(model)` (lib/models.js): read from the engine's builtin provider config (`modelRules[].config.properties.inputFormat.supportsImage`, last matching rule wins), fallback `{GLM-5.3: false, GLM-5.3-Flash: true}`. `zcode doctor` prints `images` / `no images` per model; `doctor --json` gains `vision: {id: bool}`.
- Independent visual verifier (lib/verify.js, lib/executor.js): for tasks with `--visual`, zcode opens a fresh engine session on the first image-capable model (GLM-5.3-Flash, effort `high`), which serves the app, screenshots every viewport into `$ZCODE_OUT/verify/<round>/`, looks at the images and answers with a `zcode-visual` block (`criterion, viewport, met, seen, note, shot`), plus a built-in readability criterion. Its entries are the authoritative `visual`; the implementer's claims move to `executorVisual` (full record only). Unmet entries trigger a repair turn to the implementer (shared repair budget) and a new round; a verifier that fails twice yields `met: null` and `partial` with `visual not verified`. New phase `verifying` (`verifying round N`); verifier turns count in `usage`; briefs carry `seen` (200 chars) for unmet entries.
- `zcode watch [<id>… | --plan <name>] [--stall-min 8]`: live one-line-per-session view (TTY redraw every 2 s, piped: print on change). `status` gains `idleMs`/`stalled`, `wait`/`plan wait` pending lines gain `idleMs`/`stalled`. The session record's `activity` gains `modelRequests`, `subagentsRunning`, `lastToolAt`; `phaseDetail` carries the repair attempt / verify round.

### Changed

- The implementer prompt depends on image support: a model that cannot see images is told not to judge screenshots or report `visual` and to self-check visibility in the DOM; one that can is told an independent verifier re-judges. The report-only visual follow-up is removed (the verifier replaces it). The `notVerified` line now reads "visual criteria judged by an independent <model> verifier from its own screenshots (M of N met)".
- Flash everywhere by default: agent profiles copied from the desktop into a session's engine home have a frontmatter `model:` naming GLM-5.3 or GLM-5.3-Flash rewritten to the session's model (prefix kept; the live files are never edited). README examples use the default model.

## 0.5.2

Fixes from a real orchestrated run: smaller briefs, friendlier plan files, long tasks that survive, quieter discovery.

### Changed

- Briefs carry failing checks only (`checksPassed: N` counts the rest) and unmet visual entries only (`visualMet: "M/N"` always when visual was declared; criterion clipped to 160, note to 300). `decisions` are capped at 6 (`{what: 160, why: 120}`, `decisionsMore: K`), `files` at 40 (`filesMore: K`) and exclude files attributed to a concurrent session; question options are clipped to 300. The full record (`result.json`, `--full`) is unchanged.
- Default task timeout is 2 h (`7200000`, was 30 min); run/agent unchanged. A timeout's error message says how to continue: `zcode resume <id> "continue"` (plan sessions: `zcode plan resume <name> "continue"`).
- `zcode <command> --help` prints only that command's usage and flags (under 2000 bytes; `zcode plan --help` covers the subcommands). `zcode --help` keeps the full text.
- `zcode status` lists the 15 most recent sessions and one `… N more (zcode status --all)` line; `--all` lists everything. `--json` is unchanged.

### Added

- Plan files: `@file` in `decisions`/`context` resolves next to the plan file, then against the plan's cwd (same fallback for `--task contract.json`: contract dir, then `--cwd`); the error names both paths. Per-session `label` (session label becomes `plan:<name> <label>`). Top-level `limits` (timeoutMs, maxRepairs, checkTimeoutMs) default every session; a session's own limits win per key. Taken ids print one trailing `hint:` line instead of repeating advice per id.
- `plan run --preflight`: a session with `after` gets a short paragraph naming the upstream sessions (id + objective, 200 chars) that have not run yet, so it does not ask about their absence.
- Usage accounting survives failures: model requests are counted per turn (also on timeout/failure); the full result `usage` gains `modelRequests` and `incomplete: true`; the session record accumulates `usageTotal` across resumes (full result includes it, the brief does not).
- Target-repo hygiene: at task/run/agent start in a git workspace, `.zcode/` and `.playwright-mcp/` are appended to the repo's local exclude file (`git rev-parse --git-path info/exclude`; never `.gitignore`).

## 0.5.0

Quiet orchestration: the orchestrator reads less, decides once, and the executor stops guessing.

### Breaking

- `--json` now prints the **brief** (schema `zcode.brief/1`) as the final line. Use `--full` for the old full record (`zcode.result/1`). `result.json` on disk is always the full record.

### Added

- Brief output by default (one compact result); `--full` and `zcode result <id> [--full]` for the whole record.
- One-line `wait` timeout; `wait --any` returns on the first finished session.
- Quiet errors: usage errors are one line; `--quiet` drops progress.
- Effort/model validated against the engine's levels before any spawn (exit 2).
- Per-session `ZCODE_PORT` / `ZCODE_OUT` / `ZCODE_TMP` env for parallel-safe sessions; `.zcode/` and `.playwright-mcp/` are never reported as task changes.
- `--touch` for minimal edits outside `--owns`, reported as "touched".
- Decisions: `--decision` / `--decisions`, structured questions (`q`/`options`/`recommend`), and executor-reported decisions in the handback; dedupe of repeated context/files.
- Missing `visual` results trigger one cheap report-only follow-up (no repair budget) before any visual repair turn; the prompt says every declared criterion must be reported.
- `--preflight`: read-only pass listing the open questions before any edit.
- `--unit "n: goal [owns a,b]"`: one subagent per unit inside a session.
- Visual verification: `--visual`, `--viewport`, `--serve`; screenshots judged per criterion, results in the brief.
- `zcode plan check|run|wait|status|resume`: a DAG of task sessions with shared decisions/context.
- Orchestrator skills rewritten for decide-once orchestration.

### Fixed

- Playwright MCP scratch files in `--cwd` no longer turn visual sessions `partial`.
- `plan wait` timeout prints a single line in human mode.
- Live tests updated for engine 0.16.9 (default playwright MCP server, no `state.updated` mode frame) and a bad require path.

### Measured (`node scripts/measure.js --compare docs/baseline.json`)

| Gate | Result |
| --- | --- |
| result <= 20% of baseline | 480 B vs 2970 B (16.2%) |
| wait timeout <= 120 B/session | 192 B for 2 sessions (96 B each; baseline 1518 B) |
| prompt (bare contract) <= baseline + 400 B | 6389 B vs 5995 B |
| prompt as sent <= baseline + 800 B | 6734 B vs 5995 B |
| wall time <= baseline +5% (+300 ms) | 310 ms vs 299 ms |

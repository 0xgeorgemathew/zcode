# Changelog

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

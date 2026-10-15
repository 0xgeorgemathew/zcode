---
name: zcode
description: Delegate scoped implementation work to the zcode CLI (GLM-5.3 executor) and consume its verified handback. Use when you are orchestrating and want a page, component, fix or other bounded unit implemented and checked by an independent executor session — alone or several in parallel — while you keep product, design and planning decisions.
---

# Operating zcode as an executor

zcode is a CLI execution engine. You hand it a scoped task; it implements the task in its own session, runs your acceptance checks itself, repairs failures within a budget, and returns a structured handback. You stay the orchestrator. You decide what to build and how it should look, how to split the work, when to run sessions in parallel, and when to review. zcode decides routine implementation details within the scope you give it.

Check it is ready once per machine: `zcode doctor` (exit 3 means no key, so run `zcode login`; exit 4 means the engine is missing).

## When to use it

- Use it for bounded implementation work with a clear outcome: one page, a few components, a bug fix, a refactor of a known area, a test suite for a module.
- Don't use it for product or design decisions, open-ended exploration, or work you can't describe a finished state for. Decide those yourself first, then delegate the implementation.
- Size each session so you could review its result in one sitting. Several small sessions beat one huge one, because each returns its own evidence.

## Writing the handoff

Only the objective is required. Add what the executor cannot infer:

| field | flag | give it when |
|---|---|---|
| objective | positional text | always: the outcome, not the steps |
| acceptance | `--accept "…"` | you have criteria beyond "it works" |
| checks | `--check "cmd"` | always if possible: shell commands zcode runs itself (build, tests, lint, a grep) |
| owns | `--owns path/or/glob` | other sessions may touch the same repo |
| files | `--file path` | specific files to read first |
| context / design | `--context "…"` or `--context @notes.md` | design decisions, copy, references, constraints |
| everything | `--task contract.json` | larger handoffs (keys: objective, scope, constraints, design, acceptance, checks, files, references, context, owns, limits, model, effort) |

Rules that keep you in charge:

- Put design decisions in `design` (JSON) or `--context`, written as decisions ("Hero uses the dark palette; CTA right-aligned"). The executor is told to implement them exactly and to report `blocked` rather than invent product or design choices.
- Make checks mechanical and fast. A task with no `--check` can only come back `unverified`.
- Don't ask zcode to commit, push, or deploy unless you mean it. It won't by default.

## Running sessions

Your Bash tool times out (2 minutes by default, 10 at most), and real tasks usually take longer. Start them detached and wait in bounded slices:

```sh
zcode task --detach --id <id> --cwd <repo> [flags] "<objective>"   # prints the id, returns at once
zcode wait <id> --timeout-ms 540000 --json --quiet                  # exit 124 = still running: wait again
```

You can also run a foreground `zcode task … --json --quiet` with `run_in_background: true` and read its single result line when you're notified. Quick tasks (well under 2 minutes) can run in the foreground directly.

- `zcode status` lists sessions. `zcode status <id> --json` shows the state (`queued|running|finished|interrupted`), phase (`starting|executing|checking|repairing|reporting`), activity, recent events, and the result once finished. Use it only when you need it. You don't have to watch progress, and nothing waits for your approval.
- `zcode cancel <id>` stops the turn and any running check; the session is recorded as `cancelled`.
- `zcode resume <id> "<message>"` continues the same session with its context intact. Use it to answer questions, request follow-up changes, or continue after `interrupted`, `failed`, or `partial`. It accepts `--detach`, `--model`, `--effort`, `--timeout-ms`, and `--max-repairs`. The scope (`--cwd`, `--owns`, checks) stays as it was.
- Pick your own `--id` values (`page-1`, `fix-auth`) so you can retry safely. A start with an existing id is refused (exit 2) instead of running the work twice.

## Parallel sessions

- Each session has its own engine context, so nothing leaks between them.
- Sessions in the same repo must declare disjoint `--owns`. An overlapping start is refused with exit 7, and the error names the conflicting session. Fix the split, wait, or give the session its own `git worktree` and point `--cwd` at it.
- After the work, each handback lists changed files. Anything outside the session's ownership appears in `scopeViolations` and makes the result `partial`.
- You integrate the results. zcode doesn't coordinate sessions with each other.

## Reading the handback

The result (`--json`: one `{"type":"result"}` line) has `status`, `summary`, `changes.files`, `checks` (zcode's own runs, with output tails), `issues`, `questions`, `unresolved`, `notVerified`, `scopeViolations`, `subagents`, and `handback` (the executor's own claims).

| status | exit | what it means | what you do |
|---|---|---|---|
| `completed` | 0 | zcode's checks passed, executor reports done, scope respected | review on your own schedule; integrate |
| `unverified` | 9 | executor says done, but there were no checks (or no usable handback) | verify yourself, or resume with a check added to the message |
| `partial` | 8 | work remains, a criterion is unmet, or files changed outside scope | read `issues`/`unresolved`/`scopeViolations`; resume or re-scope |
| `blocked` | 10 | needs you: see `questions` | decide, then `zcode resume <id> "<answer>"` |
| `failed` | 8 / 5 / 124 | `error.kind`: `checks_failed` (still failing after repairs), turn/engine error, or `timeout` | read `checks[].output` / `error`; resume with guidance or re-scope |
| `cancelled` | 130 | stopped | resume if wanted |

Trust `status`, `checks`, and `changes`. They come from what zcode observed. Treat `handback` and `summary` as the executor's report. A subagent's `success` only means it returned. zcode already verified the integrated result through your checks, so you don't need to review per subagent or per step.

## Example: small task

```sh
zcode task --id fix-typo --cwd ~/site --owns README.md \
  --check "grep -q '^# Acme Docs' README.md" \
  "Fix the misspelled top-level heading in README.md (should read 'Acme Docs')" --json --quiet
```

Exit 0 means it's done. The result line shows the single changed file and the passing check.

## Example: Page 1 and Page 2 in parallel

You've already decided the design. Each page gets its own session, its own scope, and its own checks:

```sh
zcode task --detach --id page-1 --cwd ~/site --label "Home page" \
  --owns src/pages/home/ --file src/theme.ts \
  --context @specs/home.md \
  --accept "Hero, three feature cards, footer CTA as specified" \
  --check "npm run build" --check "npm test -- home" \
  "Implement the Home page exactly as specified in the context"

zcode task --detach --id page-2 --cwd ~/site --label "Pricing page" \
  --owns src/pages/pricing/ --file src/theme.ts \
  --context @specs/pricing.md \
  --accept "Three plan cards, middle one highlighted; monthly/yearly toggle" \
  --check "npm run build" --check "npm test -- pricing" \
  "Implement the Pricing page exactly as specified in the context"

zcode wait page-1 page-2 --timeout-ms 540000 --json --quiet   # repeat while exit is 124
```

If `page-2` comes back `blocked` with "Should yearly prices show the discount badge?", decide and run `zcode resume page-2 "Yes, show the 'Save 20%' badge on yearly." --detach`, then wait again. To run the pages one after another instead, start `page-2` after `page-1`'s handback. The shared `src/theme.ts` is passed with `--file` (read), not owned, so a change to it by either session would come back as a scope violation. If a page truly needs a shared change, make it yourself or give that file to exactly one session's `--owns`.

## Exit codes

0 completed · 2 usage (bad flag, contract, or duplicate id) · 3 no key · 4 no engine · 5 failed · 6 `agent` had no subagent · 7 workspace conflict / session busy · 8 partial or checks failing · 9 unverified · 10 blocked · 124 timeout (for `wait`: still running) · 130 cancelled.

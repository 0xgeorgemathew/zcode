---
name: zcode
description: Delegate scoped implementation work to the zcode CLI (GLM-5.3-Flash executor: sees images, has Playwright; an independent vision verifier judges UI) and consume its compact verified handback. Use when you are orchestrating: you make the product, design and logic decisions once, then zcode implements, tests, visually verifies and repairs — in one session with subagent units, several parallel sessions, or a dependency plan — while you spend tokens only on decisions and exceptions.
---

# Operating zcode as an executor

zcode is a CLI execution engine. You decide; it builds. It implements a scoped task in its own session, runs your checks itself, has a fresh, independent vision verifier screenshot and judge UI when you ask, repairs failures within a budget, and returns a small structured handback.

**The point is token economy.** Your tokens go to decisions and exceptions. Everything mechanical — writing code, running builds and tests, reading diffs, looking at screenshots, fixing small failures — is zcode's. If you are doing any of that after dispatch, you are paying twice.

Check readiness once per machine: `zcode doctor` (exit 3 → `zcode login`; exit 4 → engine missing). Don't run `--help` or a bare `zcode status`: everything you need is here.

## The workflow

1. **Read** the codebase as much as you need to plan. This is the one phase where reading files is expected.
2. **Decide** everything a user could see or a system depends on (checklists below). Write the decisions down once, as decisions — a file such as `docs/decisions.md` that sessions receive with `--decisions @file`.
3. **Shape** the work: one session with units, several sessions, or a plan (next section).
4. **Preflight** (optional): `--preflight` makes zcode list every question it would otherwise guess; answer them all in one edit to the decisions file. It costs you a round trip, so use it only when your decisions have known gaps or the work is large and novel; skip it when the checklists below are fully covered.
5. **Dispatch and wait** with `--detach` + `zcode wait`, or `zcode plan run` + `zcode plan wait`.
6. **Handle exceptions only.** `completed` → move on. Anything else → read only what the brief shows, answer or adjust in one line with `zcode resume`.

## Deciding: leave nothing open-ended

The executor implements binding decisions exactly and is told not to invent anything user-visible or behavioural. Gaps either block it (a round trip for you) or get the most conservative default. Close them up front.

**Front end:** palette (exact values), type families and scale, spacing scale, radii, iconography/illustration style; every section's layout and hierarchy at each breakpoint you care about; exact copy; component states (hover, focus, active, disabled, loading, empty, error); motion (what moves, property, distance, duration, easing, stagger, trigger, reduced-motion behaviour); accessibility (focus order, traps, labels, contrast floor); stack and libraries; performance budget.

**Back end / logic:** data shapes and storage keys; API routes, payloads, status codes and errors; validation rules (exact regexes, ranges); state machines (steps, transitions, what persists, what resets); auth and permissions; idempotency and retries; what is mocked vs real; side effects that are forbidden.

**Boundaries:** what the executor may choose freely (internal names, file structure, helpers) and what it must ask about.

Keep the decisions file dense: tables and one-line statements, no prose, no rationale the executor doesn't need (aim for a few thousand tokens for a one-page site). Write decisions as statements, not wishes: "Reveal: opacity 0→1 and translateY 16px→0, 400 ms, cubic-bezier(.2,.7,.2,1), 60 ms stagger, at 20% visibility; reduced motion: opacity only."

## Shaping the work

Pick the cheapest shape that keeps each session finishable without you.

- **One session with units** when the pieces share context (one page's sections, one module's functions). `--unit "hero: …"` per piece; zcode gives each unit its own subagent and integrates.
- **Several sessions** when pieces are independent and own disjoint paths. Launch them `--detach` in parallel; each may have its own units.
- **A plan** when there are dependencies (scaffold → parallel features → integration). `zcode plan run plan.json` sequences and parallelises for you; you wait once.

Parallel safety is automatic: each session gets `ZCODE_PORT`, `ZCODE_OUT`, `ZCODE_TMP` and `ZCODE_SESSION_ID`. Tell the first (scaffold) session to make dev-server ports, build output dirs and test artifacts honour them. zcode keeps `.zcode/` and `.playwright-mcp/` out of git via the repo's local `.git/info/exclude`; you don't need to touch `.gitignore` for them.

## The handoff

| field | flag | give it when |
|---|---|---|
| objective | positional text | always: the outcome, not the steps |
| decisions | `--decision "…"`, `--decisions @file` | always for anything user-visible or behavioural |
| checks | `--check "cmd"` | always: build, typecheck, tests, lint, greps — zcode runs them itself |
| visual | `--visual "criterion"`, `--viewport WxH`, `--serve "cmd"` | any UI work: after the build, a fresh vision verifier serves on $ZCODE_PORT, waits for animations to finish, screenshots each viewport, quotes the text it can actually see, judges each criterion (plus "all intended text is readable"), and unmet ones go back to the implementer for repair. Phrase criteria as what must be visible: "hero headline 'Your money, simplified' is fully readable at 390 and 1440" |
| units | `--unit "name: objective [owns a,b]"` | one session should fan out to subagents |
| owns | `--owns path/glob` | always when other sessions may run in the same repo |
| touch | `--touch path` | a small edit to a shared file no running session owns |
| files | `--file path` | files to read first (don't also pass them as `--context @`) |
| context | `--context "…"` / `--context @file` | background that isn't a decision |
| acceptance | `--accept "…"` | criteria beyond checks and visuals |
| everything | `--task contract.json` | keys: objective, scope, constraints, decisions, design, acceptance, checks, visual, viewports, units, files, references, context, owns, touch, limits, model, effort |

Model and effort: don't pass `--model`. Everything runs on GLM-5.3-Flash by default (it sees images): sessions, units, plans, the verifier. Use `--model glm-5.3` only when the user asks for it; it can't see images. `--effort low|high|max` (default `max`). Other values are refused before anything starts.

## Running

```sh
zcode task --detach --id <id> --cwd <repo> [flags] "<objective>"   # prints the id, returns at once
zcode wait <id…> --timeout-ms 540000 --json --quiet                # 124 = still running (one line each): wait again
zcode wait <id…> --any --timeout-ms 540000 --json --quiet          # return on the first that finishes
zcode resume <id> "<answer or follow-up>" --detach                 # same session, context intact
zcode result <id> [--full]                                         # brief again, or the full record
zcode cancel <id>
```

Plans:

```sh
zcode plan check plan.json
zcode plan run plan.json --detach [--preflight]
zcode plan wait <name> --timeout-ms 540000 --json   # one summary line per session; details only for non-completed
zcode plan resume <name> ["<message>"]              # resume failed/partial, relaunch skipped
zcode plan resume <name> --session <id> "<answer>"  # answer one blocked session
```

`plan.json`: `{"cwd"?, "decisions"?, "context"?, "files"?, "model"?, "effort"?, "limits"?, "sessions": [{"id", "after"?: [ids], "label"?, ...contract keys}]}`. Top-level decisions/context/files/limits go to every session; `@` entries resolve against the plan file's directory, then the plan's cwd. Don't also list the decisions file under `files`: it is already inlined. The plan name is the file basename (or `--id`). Sessions that can run at the same time must own disjoint paths; `plan check` enforces it. When an upstream session ends non-completed, its dependants are `skipped` until you `plan resume`.

Session ids are global and permanent: give every new run a fresh prefix (`wc3-scaffold`, …) so `plan check` passes first time. A task session may run 2 h by default; a big session (a whole page, a whole flow) can set `"limits": {"timeoutMs": 10800000}`. If one still times out, `zcode plan resume <name> "continue"` picks up from the files it already wrote.

While sessions run, the user can watch them with `zcode watch` (live phase, last tool, model requests, `STALLED?` after 8 idle minutes); you never run it. `wait` timeout lines carry `idleMs`/`stalled`: a stalled session is the one case to `cancel` + `resume` early.

Your Bash tool times out at 10 minutes; always wait in bounded slices. Run the wait with `run_in_background` if you have other planning to do.

## Reading the brief

`--json` prints one compact line: `status`, `summary`, `files`, failing `checks` with tails (`checksPassed` counts the rest), `questions`, `issues`, `unresolved`, `scopeViolations`, `touched`, the first `decisions` (`decisionsMore` counts the rest), unmet `visual` with what the verifier actually `seen` (`visualMet` is "met/total"), `units`, and `result` (path to the full record). Read it straight from the command output; don't pipe it through jq, python or tail.

| status | exit | do |
|---|---|---|
| `completed` | 0 | nothing. Skim `decisions` (the executor's own in-scope choices); veto with `resume` only if one is wrong |
| `blocked` | 10 | answer `questions` (they come with options and a recommendation) via `zcode resume <id> "<answer>"`, and add the answer to your decisions file |
| `partial` | 8 | read `issues` / `unresolved` / unmet `visual` / `scopeViolations`; resume with one-line guidance or re-scope |
| `failed` | 8/5/124 | read the failing check `tail` or `error`; resume with guidance |
| `unverified` | 9 | you forgot checks: resume with a check added |
| `cancelled` | 130 | resume if wanted |

## Hard rules after dispatch

- Don't open files a `completed` session changed. Don't re-run checks it ran. Don't look at its screenshots.
- Don't poll `status`; use `wait` (or `plan wait`) once, in the background if you like, and act on its exit.
- Don't fix code yourself; `resume` the session with one line.
- Need to know something about the result? `zcode result <id> --full` first; read code only as a last resort.
- Don't ask zcode to commit, push, publish or deploy unless the user asked; when they did, make it its own final session gated on everything else being `completed`.

## Example: a marketing one-pager with an application form

You read the empty repo, decide the design system, copy, motion, form logic and demo constraints, and write `docs/decisions.md`. Then `plan.json`:

```json
{
  "decisions": ["@docs/decisions.md"],
  "effort": "high",
  "sessions": [
    {"id": "scaffold", "owns": ["package.json", "package-lock.json", "index.html", "*.config.*", "tsconfig*.json", "src/app/**", "src/styles/**", "src/components/**", "e2e/smoke.spec.ts", ".gitignore"],
     "objective": "Vite + React + TS scaffold, tokens, shared shell, stubs for src/landing and src/apply; dev/preview/e2e honour ZCODE_PORT and ZCODE_OUT",
     "checks": ["npm run build", "npm test", "npm run e2e"]},
    {"id": "landing", "after": ["scaffold"], "owns": ["src/landing/**", "e2e/landing.spec.ts"],
     "objective": "All landing sections per the decisions",
     "units": ["hero: …", "highlights: …", "products: …", "how: …", "charges: …", "faqs: …", "about-cta: …"],
     "checks": ["npm run build", "npx playwright test e2e/landing.spec.ts"],
     "visual": ["hero headline fits on two lines at 390px", "product cards align on one row at 1440px", "no text overlaps any circle motif"]},
    {"id": "apply", "after": ["scaffold"], "owns": ["src/apply/**", "e2e/apply.spec.ts"],
     "objective": "Application dialog: demo OTP, four steps, local draft, thank-you",
     "checks": ["npm run build", "npm test -- apply", "npx playwright test e2e/apply.spec.ts"],
     "visual": ["OTP code is visible on screen after entering a number", "step indicator shows the current step at 390px"]},
    {"id": "integration", "after": ["landing", "apply"], "owns": ["src/App.tsx", "e2e/**"],
     "objective": "Wire everything, full-page pass, fix integration issues",
     "checks": ["npm run build", "npm test", "npm run e2e"],
     "visual": ["full page at 390 and 1440 matches the decisions; motion respects reduced motion"]}
  ]
}
```

`zcode plan check plan.json` → `zcode plan run plan.json --preflight` (read-only `<id>.pre` sessions, all at once; downstream sessions are told their upstream hasn't run yet; prints only the questions) → answer them once in the decisions file → `zcode plan run plan.json --detach` → `zcode plan wait plan --timeout-ms 540000 --json`. Your total involvement: the decisions, one answer pass, one summary.

## Exit codes

0 completed · 2 usage (bad flag, contract, plan, effort, or duplicate id) · 3 no key · 4 no engine · 5 failed · 6 `agent` had no subagent · 7 workspace conflict / session busy · 8 partial or checks failing · 9 unverified · 10 blocked · 124 timeout (for `wait`: still running) · 130 cancelled.

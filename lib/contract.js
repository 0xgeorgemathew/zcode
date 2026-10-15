'use strict';
// The task contract (handoff) and the handback.
//
// Handoff: an orchestrator describes the work as a small JSON object (or a
// markdown brief, or just flags). Only `objective` is required; everything
// else scales with the task. zcode renders it into the executor protocol
// prompt below.
//
// Handback: the model ends its final message with a fenced `zcode-handback`
// JSON block. That block is a CLAIM. The status zcode reports is derived
// from evidence zcode gathered itself (its own check runs, the workspace
// diff, the ownership scope) and only falls back on the claim for what
// cannot be checked mechanically — and says so in `notVerified`.

class ContractError extends Error {}

const CONTRACT_KEYS = [
  'objective',
  'scope',
  'constraints',
  'design',
  'acceptance',
  'checks',
  'files',
  'references',
  'context',
  'owns',
  'limits',
  'model',
  'effort',
];
const LIMIT_KEYS = ['timeoutMs', 'maxRepairs', 'checkTimeoutMs'];

const asList = (v) =>
  v === undefined || v === null
    ? []
    : (Array.isArray(v) ? v : [v]).map((x) => String(x).trim()).filter(Boolean);

// Builds a contract from an optional base object (JSON file / markdown
// brief) plus CLI additions. Throws ContractError on unknown keys or a
// missing objective — before any engine spawn.
function normalizeContract(base = {}, additions = {}) {
  if (!base || typeof base !== 'object' || Array.isArray(base)) {
    throw new ContractError('task contract must be a JSON object');
  }
  const unknown = Object.keys(base).filter((k) => !CONTRACT_KEYS.includes(k));
  if (unknown.length) {
    throw new ContractError(
      `unknown task contract key(s): ${unknown.join(', ')}. Accepted: ${CONTRACT_KEYS.join(', ')}`
    );
  }
  const limits = base.limits || {};
  if (typeof limits !== 'object' || Array.isArray(limits)) {
    throw new ContractError('contract "limits" must be an object');
  }
  const badLimit = Object.keys(limits).filter((k) => !LIMIT_KEYS.includes(k));
  if (badLimit.length) {
    throw new ContractError(`unknown limits key(s): ${badLimit.join(', ')}. Accepted: ${LIMIT_KEYS.join(', ')}`);
  }
  for (const k of LIMIT_KEYS) {
    if (limits[k] !== undefined && !(Number.isFinite(limits[k]) && limits[k] >= 0)) {
      throw new ContractError(`contract limits.${k} must be a non-negative number`);
    }
  }
  const objective = [String(base.objective ?? '').trim(), String(additions.objective ?? '').trim()]
    .filter(Boolean)
    .join('\n\n');
  if (!objective) {
    throw new ContractError('the task needs an objective (positional text, --task file, or "objective" in JSON)');
  }
  return {
    objective,
    scope: asList(base.scope),
    constraints: asList(base.constraints),
    design: asList(base.design),
    acceptance: [...asList(base.acceptance), ...asList(additions.acceptance)],
    checks: [...asList(base.checks), ...asList(additions.checks)],
    files: [...asList(base.files), ...asList(additions.files)],
    references: asList(base.references),
    context: [...asList(base.context), ...asList(additions.context)],
    owns: [...asList(base.owns), ...asList(additions.owns)],
    limits: { ...limits },
    model: base.model ?? null,
    effort: base.effort ?? null,
  };
}

// --- prompts ------------------------------------------------------------------

const bullets = (items) => items.map((i) => `- ${i}`).join('\n');

function section(title, items) {
  return items.length ? `## ${title}\n${bullets(items)}\n` : '';
}

const HANDBACK_SPEC = [
  'End your final message with exactly one fenced block in this form (valid JSON):',
  '```zcode-handback',
  '{"status": "done | partial | blocked",',
  ' "summary": "one or two sentences: what you delivered",',
  ' "changes": [{"path": "relative/path", "what": "short description"}],',
  ' "checks": [{"what": "command or inspection you ran", "result": "pass | fail | not-run", "evidence": "short"}],',
  ' "criteria": [{"criterion": "acceptance criterion", "met": true, "evidence": "short"}],',
  ' "unresolved": ["problems inside your scope that remain unfixed"],',
  ' "questions": ["what you need from the orchestrator (only when blocked)"],',
  ' "notes": "risks or follow-ups the orchestrator should know"}',
  '```',
  '"done" means every acceptance criterion is met and verified; "partial" means some work remains; "blocked" means you cannot proceed without the orchestrator.',
].join('\n');

// `ownsDisplay` are the patterns as the caller wrote them (relative to cwd).
function buildTaskPrompt(contract, { ownsDisplay = contract.owns } = {}) {
  const parts = [
    'You are Zcode, an execution engine invoked by an orchestrator agent. The orchestrator owns product decisions, design direction, planning and task boundaries. You own implementation and verification inside the scope of this task. Work autonomously: there is no human watching and nobody reviews your intermediate steps.',
    '',
    `## Objective\n${contract.objective}\n`,
    section('Scope', contract.scope),
    section('Constraints', contract.constraints),
    section('Design decisions (supplied by the orchestrator: implement them exactly; do not change them)', contract.design),
    section('Relevant files (read these first)', contract.files),
    section('References', contract.references),
    section('Context', contract.context),
    section('Acceptance criteria', contract.acceptance),
    ownsDisplay.length
      ? `## Workspace ownership\nYou may create, modify or delete ONLY these paths (relative to the working directory):\n${bullets(ownsDisplay)}\nOther sessions may be working in this workspace at the same time: do not touch anything else, and do not run formatters or code generators over the whole repository.\n`
      : '',
    contract.checks.length
      ? `## Acceptance checks\nAfter you finish, Zcode will run these commands in the working directory and treat any non-zero exit as a failure. Run them yourself before you finish:\n${bullets(contract.checks.map((c) => `\`${c}\``))}\n`
      : '',
    [
      '## How to work',
      '- Make routine implementation decisions yourself. Do not stop to ask for approval of intermediate steps.',
      '- Do not make product or design decisions the orchestrator has not made. If one is consequential and cannot be resolved from this task, report status "blocked" with your questions instead of guessing.',
      '- You may use the Agent tool for independent units of work. Give each subagent a bounded objective and an explicit list of files it may change; never let two subagents change the same file. A subagent reporting success is a claim: inspect its changes and verify the integrated result yourself.',
      '- Verify every acceptance criterion against the actual result. When something fails, diagnose and fix it, then verify again.',
      '- Do not commit, push, publish, deploy, or cause other external side effects unless this task explicitly asks for it.',
      '- Report "blocked" only when you lack information or authority that this task does not provide (for example a missing credential, a required change outside your ownership, or a consequential ambiguity).',
      '',
    ].join('\n'),
    `## Handback\n${HANDBACK_SPEC}`,
  ];
  return parts.filter(Boolean).join('\n');
}

function buildRepairPrompt(failures, { attempt, maxRepairs }) {
  const blocks = failures.map((f) => {
    const why = f.timedOut ? 'timed out' : `exit ${f.exitCode}`;
    return `### \`${f.command}\` (${why})\n\`\`\`\n${f.output.trim().slice(-3000) || '(no output)'}\n\`\`\``;
  });
  return [
    `Zcode ran the acceptance checks and ${failures.length === 1 ? 'one failed' : `${failures.length} failed`} (repair attempt ${attempt} of ${maxRepairs}):`,
    '',
    ...blocks,
    '',
    'Diagnose the root cause and fix it within your ownership, run the checks again yourself, then finish with a fresh zcode-handback block. If the failure is outside your scope or cannot be fixed, report status "partial" or "blocked" and explain why.',
  ].join('\n');
}

const HANDBACK_REQUEST =
  'Your previous message did not end with a valid zcode-handback block. Do not redo any work. Reply with only the handback block describing the current state.\n\n' +
  HANDBACK_SPEC;

function buildResumePrompt(message, { kind }) {
  const note =
    'Work from earlier in this session is already applied to the workspace. Inspect the current state before repeating any step, and do not repeat external side effects.';
  if (kind !== 'task') return message;
  const body = message && message.trim()
    ? `Message from the orchestrator:\n\n${message.trim()}`
    : 'Continue the task from where you stopped.';
  return `${body}\n\n${note}\n\n${HANDBACK_SPEC}`;
}

// --- handback -------------------------------------------------------------------

const HANDBACK_RE = /```zcode-handback[^\n]*\n([\s\S]*?)```/g;
const STATUS_ALIASES = new Map([
  ['done', 'done'],
  ['complete', 'done'],
  ['completed', 'done'],
  ['success', 'done'],
  ['partial', 'partial'],
  ['incomplete', 'partial'],
  ['failed', 'partial'],
  ['blocked', 'blocked'],
]);

// Returns {handback, report, error}: the LAST block wins; `report` is the
// response text with the block removed.
function parseHandback(text) {
  const source = String(text || '');
  const matches = [...source.matchAll(HANDBACK_RE)];
  if (matches.length === 0) return { handback: null, report: source.trim(), error: 'missing' };
  const last = matches[matches.length - 1];
  const report = (source.slice(0, last.index) + source.slice(last.index + last[0].length)).trim();
  let raw;
  try {
    raw = JSON.parse(last[1]);
  } catch (err) {
    return { handback: null, report, error: `invalid JSON: ${err.message}` };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { handback: null, report, error: 'not a JSON object' };
  }
  const status = STATUS_ALIASES.get(String(raw.status || '').toLowerCase()) || null;
  const arr = (v) => (Array.isArray(v) ? v : v ? [v] : []);
  return {
    handback: {
      status,
      summary: typeof raw.summary === 'string' ? raw.summary : '',
      changes: arr(raw.changes),
      checks: arr(raw.checks),
      criteria: arr(raw.criteria),
      unresolved: arr(raw.unresolved).map(String),
      questions: arr(raw.questions).map(String),
      notes: typeof raw.notes === 'string' ? raw.notes : '',
    },
    report,
    error: status ? null : 'missing or unknown status',
  };
}

// --- status ---------------------------------------------------------------------

// The single place the final status is decided.
//   completed  — zcode's own checks ran and all passed, the model reports
//                done, no unmet criteria, nothing changed outside ownership
//   unverified — the model reports done but zcode had no checks to run
//                (or no usable handback): completion is self-reported
//   partial    — work remains: model says partial / criteria unmet /
//                files changed outside ownership
//   blocked    — needs the orchestrator (questions in the result)
//   failed     — engine/turn error, timeout, or checks still failing after
//                the repair budget
//   cancelled  — stopped by zcode cancel / a signal
function deriveStatus({
  kind,
  error = null,
  cancelled = false,
  userInput = null,
  handback = null,
  handbackError = null,
  checks = [],
  scopeViolations = [],
}) {
  const issues = [];
  if (cancelled) return { status: 'cancelled', issues: ['cancelled before completion'] };
  if (userInput) {
    return { status: 'blocked', issues: [`the engine requested interactive input: ${userInput}`] };
  }
  if (error) return { status: 'failed', issues: [error.message || String(error)] };
  if (kind !== 'task') return { status: 'completed', issues };

  if (handback && handback.status === 'blocked') {
    return { status: 'blocked', issues: ['the executor reported it is blocked (see questions)'] };
  }
  const failedChecks = checks.filter((c) => !c.ok);
  if (failedChecks.length) {
    return {
      status: 'failed',
      issues: [`${failedChecks.length} of ${checks.length} acceptance check(s) failing: ${failedChecks.map((c) => c.command).join('; ')}`],
    };
  }
  let partial = false;
  if (handback && handback.status === 'partial') {
    partial = true;
    issues.push('the executor reported partial completion');
  }
  const unmet = handback ? handback.criteria.filter((c) => c && c.met === false) : [];
  if (unmet.length) {
    partial = true;
    issues.push(`unmet acceptance criteria: ${unmet.map((c) => c.criterion).join('; ')}`);
  }
  if (scopeViolations.length) {
    partial = true;
    issues.push(`changed files outside the owned scope: ${scopeViolations.join(', ')}`);
  }
  if (partial) return { status: 'partial', issues };
  if (!handback || handback.status !== 'done') {
    issues.push(`no usable handback from the executor (${handbackError || 'missing'})`);
    // Passing checks prove only the mechanical criteria; without a "done"
    // report nobody has confirmed the rest.
    return { status: 'unverified', issues };
  }
  if (!checks.length) {
    issues.push('no acceptance checks were declared, so completion is self-reported by the executor');
    return { status: 'unverified', issues };
  }
  return { status: 'completed', issues };
}

module.exports = {
  ContractError,
  CONTRACT_KEYS,
  normalizeContract,
  buildTaskPrompt,
  buildRepairPrompt,
  buildResumePrompt,
  HANDBACK_REQUEST,
  parseHandback,
  deriveStatus,
};

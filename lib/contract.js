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
  'decisions',
  'units',
  'visual',
  'viewports',
  'serve',
  'acceptance',
  'checks',
  'files',
  'references',
  'context',
  'owns',
  'touch',
  'limits',
  'model',
  'effort',
];
const LIMIT_KEYS = ['timeoutMs', 'maxRepairs', 'checkTimeoutMs'];

const asList = (v) =>
  v === undefined || v === null
    ? []
    : (Array.isArray(v) ? v : [v]).map((x) => String(x).trim()).filter(Boolean);

const uniq = (items) => [...new Set(items)];
const VIEWPORT_RE = /^\d{2,5}x\d{2,5}$/;
const DEFAULT_VIEWPORTS = ['390x844', '1440x900'];
const UNIT_KEYS = ['name', 'objective', 'owns'];

// "name: objective [owns a,b]" -> {name, objective, owns?}
function parseUnit(spec) {
  const m = /^\s*([^:]+?)\s*:\s*([\s\S]*?)\s*(?:\[owns\s+([^\]]*)\])?\s*$/.exec(String(spec));
  if (!m || !m[1].trim() || !m[2].trim()) {
    throw new ContractError(`unit "${String(spec).slice(0, 60)}" must look like "name: objective" (optionally "[owns a,b]")`);
  }
  const owns = (m[3] || '').split(',').map((x) => x.trim()).filter(Boolean);
  return { name: m[1].trim(), objective: m[2].trim(), ...(owns.length ? { owns } : {}) };
}

function normalizeUnits(items) {
  const units = items.map((raw) => {
    if (typeof raw === 'string') return parseUnit(raw);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new ContractError('contract "units" entries must be {name, objective, owns?} objects or "name: objective" strings');
    }
    const bad = Object.keys(raw).filter((k) => !UNIT_KEYS.includes(k));
    if (bad.length) throw new ContractError(`unknown unit key(s): ${bad.join(', ')}. Accepted: ${UNIT_KEYS.join(', ')}`);
    const name = String(raw.name ?? '').trim();
    const objective = String(raw.objective ?? '').trim();
    if (!name || !objective) throw new ContractError('every unit needs a name and an objective');
    const owns = asList(raw.owns);
    return { name, objective, ...(owns.length ? { owns } : {}) };
  });
  const seen = new Set();
  for (const u of units) {
    if (seen.has(u.name)) throw new ContractError(`duplicate unit name "${u.name}"`);
    seen.add(u.name);
  }
  return units;
}

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
  const viewports = uniq([...asList(base.viewports), ...asList(additions.viewports)]);
  for (const v of viewports) {
    if (!VIEWPORT_RE.test(v)) throw new ContractError(`viewport "${v}" must look like 390x844`);
  }
  const serve = String(additions.serve ?? base.serve ?? '').trim();
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
    decisions: uniq([...asList(base.decisions), ...asList(additions.decisions)]),
    units: normalizeUnits([
      ...(Array.isArray(base.units) ? base.units : base.units === undefined ? [] : [base.units]),
      ...(additions.units || []),
    ]),
    visual: uniq([...asList(base.visual), ...asList(additions.visual)]),
    viewports,
    serve,
    acceptance: uniq([...asList(base.acceptance), ...asList(additions.acceptance)]),
    checks: [...asList(base.checks), ...asList(additions.checks)],
    files: uniq([...asList(base.files), ...asList(additions.files)]),
    references: asList(base.references),
    context: uniq([...asList(base.context), ...asList(additions.context)]),
    owns: [...asList(base.owns), ...asList(additions.owns)],
    touch: [...asList(base.touch), ...asList(additions.touch)],
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
  ' "decisions": [{"what": "choice you made in scope", "why": "short"}],',
  ' "notes": "risks or follow-ups the orchestrator should know"}',
  '```',
  '"done" means every acceptance criterion is met and verified; "partial" means some work remains; "blocked" means you cannot proceed without the orchestrator.',
  'A question may be {"q": "...", "options": ["A ...", "B ..."], "recommend": "A"}.',
].join('\n');

// Rendered on every task prompt, so it stays tiny (<= 400 bytes with
// realistic paths; scripts/measure.js budgets for it). `session` is
// {id, port, out, tmp}: the environment zcode gives the executor and the
// checks so parallel sessions cannot collide.
function sessionSection(session) {
  if (!session) return '';
  return [
    '## Session environment',
    'Parallel sessions share this machine. Use these, never fixed values:',
    `- ZCODE_PORT=${session.port}: the only port to bind (dev/preview servers)`,
    `- ZCODE_OUT=${session.out}: build output dirs (e.g. --outDir) and test artifacts`,
    `- ZCODE_TMP=${session.tmp}: scratch files`,
    '',
  ].join('\n');
}

function unitsSection(units) {
  if (!units || !units.length) return '';
  const lines = units.map((u) => `${u.name}: ${u.objective}${u.owns && u.owns.length ? ` (owns: ${u.owns.join(', ')})` : ''}`);
  return `## Units\nDispatch each unit below to its own subagent (Agent tool) with that unit's objective, the binding decisions above and its owns. Run independent units in parallel, then integrate and verify the whole. Report each in handback \`units\`: [{"name", "status", "note"}].\n${bullets(lines)}\n`;
}

// Only rendered when the contract declares visual criteria.
function visualSection(contract) {
  if (!contract.visual || !contract.visual.length) return '';
  const viewports = contract.viewports && contract.viewports.length ? contract.viewports : DEFAULT_VIEWPORTS;
  return [
    '## Visual verification',
    'Verify the rendered result yourself with Playwright; you can look at screenshots.',
    contract.serve
      ? `- Serve the app with \`${contract.serve}\` on $ZCODE_PORT (it must honour that port).`
      : '- Serve the app on $ZCODE_PORT (pick the dev/preview command from package.json; no other port).',
    `- At each viewport (${viewports.join(', ')}) capture screenshots into $ZCODE_OUT/shots: the full page plus every key state a criterion names.`,
    '- Look at the screenshots and judge each criterion. Fix failures, re-capture, judge again. Stop the server when done.',
    'Criteria:',
    bullets(contract.visual),
    'Report in handback `visual`: [{"criterion", "viewport", "met", "note", "shot"}] (shot = screenshot path); it MUST include an entry for every criterion above.',
    '',
  ].join('\n');
}

const PREFLIGHT_SECTION = [
  '## Preflight (read-only)',
  'This turn is a preflight, not the task. Make NO edits: do not create, modify or delete files, and run nothing with side effects. Read what you need, then list every open question you would otherwise have to guess (user-visible or behavioural choices the binding decisions and context do not settle) in handback `questions`, each as {"q": "...", "options": ["A ...", "B ..."], "recommend": "A"}. Report status "blocked" with those questions, or "done" with summary "no open questions" if there are none. The orchestrator will answer, then continue this session.',
  '',
].join('\n');

// `ownsDisplay` are the patterns as the caller wrote them (relative to cwd).
function buildTaskPrompt(contract, { ownsDisplay = contract.owns, session = null, preflight = false } = {}) {
  const parts = [
    'You are Zcode, an execution engine invoked by an orchestrator agent. The orchestrator owns product decisions, design direction, planning and task boundaries. You own implementation and verification inside the scope of this task. Work autonomously: there is no human watching and nobody reviews your intermediate steps.',
    '',
    `## Objective\n${contract.objective}\n`,
    section('Scope', contract.scope),
    section('Constraints', contract.constraints),
    section('Binding decisions (made by the orchestrator: implement exactly)', [...(contract.decisions || []), ...contract.design]),
    section('Relevant files (read these first)', contract.files),
    section('References', contract.references),
    section('Context', contract.context),
    section('Acceptance criteria', contract.acceptance),
    unitsSection(contract.units),
    ownsDisplay.length
      ? `## Workspace ownership\nYou may create, modify or delete ONLY these paths (relative to the working directory):\n${bullets(ownsDisplay)}\nOther sessions may be working in this workspace at the same time: do not touch anything else, and do not run formatters or code generators over the whole repository.\n`
      : '',
    contract.touch && contract.touch.length
      ? `## Also allowed\nYou may also make minimal edits to:\n${bullets(contract.touch)}\nReport each such edit in your handback \`changes\`. Do not use this to widen the task.\n`
      : '',
    sessionSection(session),
    visualSection(contract),
    preflight ? PREFLIGHT_SECTION : '',
    contract.checks.length && !preflight
      ? `## Acceptance checks\nAfter you finish, Zcode will run these commands in the working directory and treat any non-zero exit as a failure. Run them yourself before you finish:\n${bullets(contract.checks.map((c) => `\`${c}\``))}\n`
      : '',
    [
      '## How to work',
      '- Make routine implementation decisions yourself. Do not stop to ask for approval of intermediate steps.',
      '- Where the binding decisions and context leave something user-visible or behavioural open, do not guess: if it blocks the work, report "blocked" with a structured question; otherwise take the most conservative choice and list it in handback `decisions`.',
      '- Do not make product or design decisions the orchestrator has not made. If one is consequential and cannot be resolved from this task, report status "blocked" with your questions instead of guessing.',
      '- You may use the Agent tool for independent units of work. Give each subagent a bounded objective and an explicit list of files it may change; never let two subagents change the same file. A subagent reporting success is a claim: inspect its changes and verify the integrated result yourself.',
      '- Verify every acceptance criterion against the actual result. When something fails, diagnose and fix it, then verify again.',
      '- Do not commit, push, publish, deploy, or cause other external side effects unless this task explicitly asks for it.',
      '- Report "blocked" only when you lack information or authority that this task does not provide (for example a missing credential, a required change outside your ownership, or a consequential ambiguity).',
      '',
    ].join('\n'),
    `## Handback\n${HANDBACK_SPEC}${contract.visual && contract.visual.length ? '\nThe handback MUST include a `visual` entry for every declared visual criterion.' : ''}`,
  ];
  return parts.filter(Boolean).join('\n');
}

function buildRepairPrompt(failures, { attempt, maxRepairs, visual = [] }) {
  const blocks = failures.map((f) => {
    const why = f.timedOut ? 'timed out' : `exit ${f.exitCode}`;
    return `### \`${f.command}\` (${why})\n\`\`\`\n${f.output.trim().slice(-3000) || '(no output)'}\n\`\`\``;
  });
  const head = failures.length
    ? `Zcode ran the acceptance checks and ${failures.length === 1 ? 'one failed' : `${failures.length} failed`} (repair attempt ${attempt} of ${maxRepairs}):`
    : `Your visual verification left criteria unmet (repair attempt ${attempt} of ${maxRepairs}).`;
  const lines = [head, '', ...blocks];
  if (visual.length) {
    lines.push(
      failures.length ? '' : null,
      'Visual criteria not met (or not reported):',
      ...visual.map((v) => `- ${v}`),
      'Serve the app on $ZCODE_PORT again, fix the cause, re-capture the screenshots, judge them again and report `visual` for every criterion.'
    );
  }
  lines.push(
    '',
    failures.length
      ? 'Diagnose the root cause and fix it within your ownership, run the checks again yourself, then finish with a fresh zcode-handback block. If the failure is outside your scope or cannot be fixed, report status "partial" or "blocked" and explain why.'
      : 'Finish with a fresh zcode-handback block. If a criterion cannot be met within your scope, report status "partial" or "blocked" and explain why.'
  );
  return lines.filter((l) => l !== null).join('\n');
}

const HANDBACK_REQUEST =
  'Your previous message did not end with a valid zcode-handback block. Do not redo any work. Reply with only the handback block describing the current state.\n\n' +
  HANDBACK_SPEC;

// Cheap report-only follow-up when declared visual criteria were left out of
// the handback (no redo, no repair budget).
function buildVisualReportRequest(missing) {
  return `Do not redo any work. Reply with only the handback block, including \`visual\` for every criterion: ${missing.join('; ')}\n\n` + HANDBACK_SPEC;
}

function buildResumePrompt(message, { kind, portChange = null }) {
  const note =
    'Work from earlier in this session is already applied to the workspace. Inspect the current state before repeating any step, and do not repeat external side effects.';
  if (kind !== 'task') return message;
  const body = message && message.trim()
    ? `Message from the orchestrator:\n\n${message.trim()}`
    : 'Continue the task from where you stopped.';
  const env = portChange ? `\n\nZCODE_PORT is now ${portChange} (the previous port was taken); bind that one.` : '';
  return `${body}\n\n${note}${env}\n\n${HANDBACK_SPEC}`;
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

const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);

// Plain-string questions stay strings; structured ones are {q, options?, recommend?}.
function question(q) {
  if (!isObject(q) || typeof q.q !== 'string') return isObject(q) ? JSON.stringify(q) : String(q);
  const options = Array.isArray(q.options) ? q.options.map(String) : [];
  return {
    q: q.q,
    ...(options.length ? { options } : {}),
    ...(q.recommend !== undefined && q.recommend !== null && q.recommend !== '' ? { recommend: String(q.recommend) } : {}),
  };
}

const questionText = (q) => (typeof q === 'string' ? q : [q.q, ...(q.options || []).map((o) => `  - ${o}`), q.recommend ? `  recommend: ${q.recommend}` : null].filter(Boolean).join('\n'));

function decision(d) {
  return isObject(d) ? { what: String(d.what ?? '').trim(), why: String(d.why ?? '').trim() } : { what: String(d ?? '').trim(), why: '' };
}

// Declared visual criteria the executor did not meet. An absent report counts
// as unmet; an entry without met:true does too.
function visualGaps(handback, declared) {
  if (!declared || !declared.length || !handback || handback.status === 'blocked') return { missing: [], failed: [] };
  const entries = handback.visual || [];
  const norm = (x) => String(x || '').trim().toLowerCase();
  const covered = (c) => entries.some((v) => {
    const a = norm(v.criterion);
    return a && (a === norm(c) || a.includes(norm(c)) || norm(c).includes(a));
  });
  return {
    missing: declared.filter((c) => !covered(c)),
    failed: entries
      .filter((v) => v.met !== true)
      .map((v) => `${v.criterion || '(unnamed)'}${v.viewport ? ` @${v.viewport}` : ''}`),
  };
}

function unmetVisual(handback, declared) {
  const { missing, failed } = visualGaps(handback, declared);
  return [...failed, ...missing.map((c) => `${c} (not reported)`)];
}

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
      questions: arr(raw.questions).map(question),
      decisions: arr(raw.decisions).map(decision).filter((d) => d.what),
      units: arr(raw.units).filter(isObject),
      visual: arr(raw.visual).filter(isObject),
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
  preflight = false,
  preflightWrote = [],
  visualDeclared = [],
}) {
  const issues = [];
  if (cancelled) return { status: 'cancelled', issues: ['cancelled before completion'] };
  if (userInput) {
    return { status: 'blocked', issues: [`the engine requested interactive input: ${userInput}`] };
  }
  if (error) return { status: 'failed', issues: [error.message || String(error)] };
  if (kind !== 'task') return { status: 'completed', issues };

  if (preflight) {
    if (preflightWrote.length) {
      return { status: 'failed', issues: [`preflight must be read-only but changed: ${preflightWrote.join(', ')}`] };
    }
    if (!handback) return { status: 'unverified', issues: [`no usable handback from the executor (${handbackError || 'missing'})`] };
    if (handback.status === 'blocked' || handback.questions.length) {
      return { status: 'blocked', issues: ['preflight found open questions (see questions)'] };
    }
    return { status: 'completed', issues };
  }
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
  const visualUnmet = unmetVisual(handback, visualDeclared);
  if (visualUnmet.length) {
    partial = true;
    issues.push(`visual criteria unmet: ${visualUnmet.join('; ')}`);
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
  sessionSection,
  CONTRACT_KEYS,
  DEFAULT_VIEWPORTS,
  parseUnit,
  questionText,
  unmetVisual,
  visualGaps,
  buildVisualReportRequest,
  normalizeContract,
  buildTaskPrompt,
  buildRepairPrompt,
  buildResumePrompt,
  HANDBACK_REQUEST,
  parseHandback,
  deriveStatus,
};

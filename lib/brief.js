'use strict';
// The compact handback: what an orchestrator reads by default (`--json`,
// `zcode result`, `zcode wait --json`). A projection of the full result
// record (schema zcode.result/1, still what result.json holds on disk and
// what `--full` prints): decision-relevant fields only, empty keys omitted,
// long text bounded, passing checks and met visual criteria reduced to a count
// (checksPassed, visualMet), decisions/files capped, and a pointer (`result`) to the full record for anything else.
const BRIEF_SCHEMA = 'zcode.brief/1';
const SUMMARY_MAX = 600;
const ERROR_MAX = 500;
const TAIL_MAX = 1500;

function clip(text, max) {
  const s = String(text ?? '');
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

const empty = (v) =>
  v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);

function briefCheck(c) {
  if (c.ok) return { command: c.command, ok: true };
  const out = { command: c.command, ok: false, exitCode: c.exitCode ?? null };
  if (c.timedOut) out.timedOut = true;
  out.tail = String(c.output || '').slice(-TAIL_MAX);
  return out;
}

const DECISIONS_MAX = 6;
const FILES_MAX = 40;
const OPTION_MAX = 300;

function briefDecision(d) {
  if (d && typeof d === 'object') return { what: clip(d.what, 160), why: clip(d.why, 120) };
  return clip(d, 160);
}

function briefVisual(v) {
  return {
    criterion: clip(v.criterion, 160),
    viewport: v.viewport,
    met: v.met === null ? null : false,
    seen: v.seen ? clip(v.seen, 200) : undefined,
    note: clip(v.note, 300),
    shot: v.shot,
  };
}

// Questions stay whole (the decision surface); only option strings are bounded.
function briefQuestion(q) {
  if (!q || typeof q !== 'object' || !Array.isArray(q.options)) return q;
  return { ...q, options: q.options.map((o) => (typeof o === 'string' ? clip(o, OPTION_MAX) : o)) };
}

const ALWAYS = new Set(['type', 'schema', 'status', 'ok', 'id']);

function buildBrief(result) {
  // checks_failed restates the failing `checks` entries below: kind only.
  const error = result.error
    ? result.error.kind === 'checks_failed'
      ? { kind: 'checks_failed' }
      : { kind: result.error.kind, message: clip(result.error.message, ERROR_MAX) }
    : null;
  // The failure message usually repeats as an issue; say it once.
  const issues = (result.issues || []).filter((i) => !(error && i === result.error.message));
  const checks = result.checks || [];
  const failing = checks.filter((c) => !c.ok);
  const passed = checks.length - failing.length;
  const visual = Array.isArray(result.visual) ? result.visual : [];
  const visualUnmet = visual.filter((v) => !(v && v.met === true));
  const decisions = Array.isArray(result.decisions) ? result.decisions : [];
  // Files a concurrent session changed are that session's, not this handback's.
  const files = ((result.changes && result.changes.files) || [])
    .filter((f) => !f.concurrentSession)
    .map((f) => f.path);
  const raw = {
    type: 'result',
    schema: BRIEF_SCHEMA,
    status: result.status,
    ok: Boolean(result.ok),
    id: result.id,
    label: result.label,
    preflight: result.preflight,
    summary: clip(result.summary, SUMMARY_MAX),
    // run/agent: the answer is the product. task: the handback is.
    response: result.kind === 'task' ? undefined : result.response,
    files: files.slice(0, FILES_MAX),
    filesMore: files.length > FILES_MAX ? files.length - FILES_MAX : undefined,
    checks: failing.map(briefCheck),
    checksPassed: passed > 0 ? passed : undefined,
    questions: Array.isArray(result.questions) ? result.questions.map(briefQuestion) : result.questions,
    issues,
    unresolved: result.unresolved,
    scopeViolations: result.scopeViolations,
    touched: result.touched,
    decisions: decisions.slice(0, DECISIONS_MAX).map(briefDecision),
    decisionsMore: decisions.length > DECISIONS_MAX ? decisions.length - DECISIONS_MAX : undefined,
    visual: visualUnmet.map(briefVisual),
    visualMet: visual.length ? `${visual.length - visualUnmet.length}/${visual.length}` : undefined,
    units: result.units,
    error,
    result: result.files && result.files.result,
  };
  const out = {};
  for (const [k, v] of Object.entries(raw)) if (ALWAYS.has(k) || !empty(v)) out[k] = v;
  return out;
}

module.exports = { buildBrief, BRIEF_SCHEMA };

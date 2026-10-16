'use strict';
// Plain-mode terminal UI. stdout carries the RESULT (the answer for run,
// the handback summary for task); stderr carries the live feed. Nothing
// here writes ANSI unless stderr/stdout is a TTY and NO_COLOR / TERM=dumb
// are unset, and nothing animates — the feed is append-only lines, so a
// non-interactive log reads exactly like the terminal did.
//
//   ▸ zcode zc-1a2b3c4d  task  GLM-5.3-Flash · effort max   session header
//   ● executing                                             phase
//   → Edit · ✓ Edit · ✗ Bash                                tools (dim)
//   ⇢ subagent started / returned                           subagents
//   ✓ npm test  3.2s · ✗ npm run lint  exit 1  1.1s         checks
//   │ thinking …                                            reasoning (opt-in)

const { questionText } = require('./contract.js');

function useColor(stream, env = process.env) {
  return Boolean(stream && stream.isTTY) && !('NO_COLOR' in env) && env.TERM !== 'dumb';
}

function painter(enabled) {
  const wrap = (code) => (t) => (enabled ? `\x1b[${code}m${t}\x1b[0m` : String(t));
  return { dim: wrap(2), bold: wrap(1), red: wrap(31), green: wrap(32), yellow: wrap(33), cyan: wrap(36) };
}

const secs = (ms) => `${(ms / 1000).toFixed(1)}s`;

function makeReporter({ quiet = false, thinking = true, stream = process.stderr, env = process.env } = {}) {
  const c = painter(useColor(stream, env));
  const out = (s) => {
    if (!quiet) stream.write(s);
  };
  let thinkingOpen = false;
  let atLineStart = true;

  const closeThinking = () => {
    if (thinkingOpen) {
      thinkingOpen = false;
      if (!atLineStart) out('\n');
      atLineStart = true;
    }
  };

  // One write per delta (not per character): prefix each new line with the
  // quote bar, dim the whole chunk once.
  const writeThinking = (delta) => {
    thinkingOpen = true;
    let text = '';
    for (const line of delta.split(/(\n)/)) {
      if (line === '\n') {
        text += '\n';
        atLineStart = true;
      } else if (line) {
        text += (atLineStart ? '│ ' : '') + line;
        atLineStart = false;
      }
    }
    out(c.dim(text));
  };

  const line = (s) => {
    closeThinking();
    out(`${s}\n`);
  };

  const onEvent = (ev) => {
    if (quiet) return;
    switch (ev.type) {
      case 'stream':
        if (ev.kind === 'reasoning_delta' && ev.delta && thinking) writeThinking(ev.delta);
        return;
      case 'session': {
        const head = `${c.bold('▸ zcode')} ${c.cyan(ev.id)}  ${ev.kind}${ev.resumed ? ' (resumed)' : ''}  ${c.dim(`${ev.model} · effort ${ev.effort}`)}`;
        const scope = [
          `  cwd ${ev.cwd}`,
          ev.owns && ev.owns.length ? `owns ${ev.owns.join(', ')}` : null,
          ev.checks && ev.checks.length ? `${ev.checks.length} check${ev.checks.length === 1 ? '' : 's'}` : null,
        ].filter(Boolean);
        line(head);
        line(c.dim(scope.join('  ·  ')));
        return;
      }
      case 'phase': {
        const extra =
          ev.phase === 'repairing' ? ` ${ev.attempt}/${ev.of}`
            : ev.phase === 'checking' ? ` ${ev.count}`
              : ev.phase === 'verifying' ? ` round ${ev.round}`
              : ev.reason ? ` (${ev.reason})` : '';
        line(`${c.cyan('●')} ${ev.phase}${extra}`);
        return;
      }
      case 'tool':
        if (ev.phase === 'started' && ev.name) line(c.dim(`  → ${ev.name}`));
        else if (ev.phase === 'error' && ev.name) line(c.dim(`  ✗ ${ev.name} error`));
        return;
      case 'subagent':
        line(c.dim(`  ⇢ subagent ${ev.phase}`));
        return;
      case 'check':
        if (ev.phase !== 'finished') return;
        if (ev.ok) line(`  ${c.green('✓')} ${ev.command}  ${c.dim(secs(ev.durationMs))}`);
        else line(`  ${c.red('✗')} ${ev.command}  ${c.dim(`${ev.timedOut ? 'timed out' : `exit ${ev.exitCode}`}  ${secs(ev.durationMs)}`)}`);
        return;
      case 'mcp':
        if (ev.status === 'connected') line(c.dim(`  ◇ mcp ${ev.name} connected`));
        else if (ev.status === 'failed' || ev.status === 'timeout') {
          line(c.dim(`  ✗ mcp ${ev.name} ${ev.status}${ev.error ? ` (${ev.error})` : ''}`));
        }
        return;
      case 'retry':
        line(c.yellow(`  ↻ retrying ${ev.phase}: ${ev.reason}`));
        return;
      default:
    }
  };

  // run-mode footer: one dim status line after the answer.
  const footer = (r) => {
    if (quiet) return;
    closeThinking();
    const parts = [
      r.model,
      `effort ${r.effort}`,
      typeof r.toolCalls === 'number' ? `${r.toolCalls} tool call${r.toolCalls === 1 ? '' : 's'}` : null,
      secs(r.durationMs),
      r.id,
    ].filter(Boolean);
    out(c.dim(`  ${parts.join('  ·  ')}\n`));
  };

  return { onEvent, closeThinking, footer };
}

const STATUS_MARK = {
  completed: '✓',
  unverified: '?',
  partial: '◐',
  blocked: '■',
  failed: '✗',
  cancelled: '■',
};

function statusColor(c, status) {
  if (status === 'completed') return c.green;
  if (status === 'failed') return c.red;
  return c.yellow;
}

// The handback as a human reads it (task results, wait, resume). Ordered by
// what an orchestrator scans for: status, what changed, what was checked,
// what is wrong, how to continue.
function formatResult(r, { color = false } = {}) {
  const c = painter(color);
  const L = [];
  const st = statusColor(c, r.status);
  L.push(`${st(`${STATUS_MARK[r.status] || '•'} ${r.status}`)}  ${c.bold(r.id)}${r.label ? `  ${r.label}` : ''}  ${c.dim(secs(r.durationMs || 0))}`);
  if (r.summary) L.push(`  ${r.summary}`);
  const files = (r.changes && r.changes.files) || [];
  if (files.length) {
    L.push(`changed  ${files.length} file${files.length === 1 ? '' : 's'}`);
    for (const f of files.slice(0, 30)) {
      const mark = f.change === 'added' ? 'A' : f.change === 'deleted' ? 'D' : 'M';
      const note = f.touched ? c.dim('  (touched)') : f.concurrentSession ? c.dim(`  (session ${f.concurrentSession})`) : !f.owned ? c.red('  outside owned scope') : '';
      L.push(`  ${mark} ${f.path}${note}`);
    }
    if (files.length > 30) L.push(c.dim(`  … ${files.length - 30} more`));
  } else if (r.changes) {
    L.push(`changed  ${r.changes.tracking === 'unavailable' ? 'not tracked' : 'nothing'}`);
  }
  if (r.checks && r.checks.length) {
    const passed = r.checks.filter((x) => x.ok).length;
    L.push(`checks   ${passed}/${r.checks.length} passed${r.repairs ? `  ·  ${r.repairs} repair turn${r.repairs === 1 ? '' : 's'}` : ''}`);
    for (const x of r.checks) {
      L.push(`  ${x.ok ? c.green('✓') : c.red('✗')} ${x.command}${x.ok ? '' : c.dim(`  ${x.timedOut ? 'timed out' : `exit ${x.exitCode}`}`)}`);
    }
  } else if (r.kind === 'task') {
    L.push('checks   none declared');
  }
  if (r.subagents && r.subagents.length) {
    L.push(`subagents ${r.subagents.length}`);
    for (const s of r.subagents) {
      L.push(c.dim(`  ${s.status === 'success' ? '✓' : '✗'} ${s.profileId || 'agent'}${s.title ? `  ${s.title}` : ''}${typeof s.durationMs === 'number' ? `  ${secs(s.durationMs)}` : ''}`));
    }
  }
  for (const [label, items] of [
    ['issues', r.issues],
    ['questions', (r.questions || []).map(questionText)],
    ['decisions', (r.decisions || []).map((d) => `${d.what}${d.why ? ` (${d.why})` : ''}`)],
    ['units', (r.units || []).map((u) => `${u.name}: ${u.status || '?'}${u.note ? ` - ${u.note}` : ''}`)],
    ['visual', (r.visual || []).map((v) => `${v.met === true ? 'met' : v.met === null ? 'NOT VERIFIED' : 'UNMET'} ${v.criterion || ''}${v.viewport ? ` @${v.viewport}` : ''}${v.note ? ` - ${v.note}` : ''}`)],
    ['unresolved', r.unresolved],
    ['not verified', r.notVerified],
  ]) {
    if (items && items.length) {
      L.push(`${label}`);
      for (const i of items) L.push(`  - ${i}`);
    }
  }
  if (r.error && r.error.message && !(r.issues || []).includes(r.error.message)) {
    L.push(`error    ${r.error.kind}: ${r.error.message.split('\n')[0]}`);
  }
  if (r.status !== 'completed' && r.status !== 'cancelled') {
    L.push(c.dim(`next     zcode resume ${r.id} "<message>"`));
  }
  return L.join('\n') + '\n';
}

// One line per session for `zcode status` without an id.
function formatSessionRow(s) {
  const when = s.updatedAt ? s.updatedAt.replace('T', ' ').slice(0, 19) : '';
  const state = s.state === 'finished' ? s.status || 'finished' : s.state;
  return `${s.id.padEnd(18)} ${String(state).padEnd(11)} ${String(s.kind || '').padEnd(5)} ${when}  ${s.label || s.cwd || ''}`;
}

// `repairing 1/2`, `verifying round 2`, or the bare phase.
function phaseText(v) {
  const d = v.phaseDetail;
  if (d && d.attempt !== undefined) return `${v.phase} ${d.attempt}/${d.of}`;
  if (d && d.round !== undefined) return `${v.phase} round ${d.round}`;
  return v.phase;
}

function formatSessionView(v, { events = [] } = {}) {
  const L = [];
  const state = v.state === 'finished' ? `finished (${v.status})` : v.state;
  L.push(`${v.id}  ${v.kind}${v.label ? `  ${v.label}` : ''}`);
  L.push(`  state    ${state}${v.live ? `  ·  phase ${phaseText(v)}  ·  pid ${v.pid}` : ''}`);
  L.push(`  cwd      ${v.cwd}`);
  if (v.owns && v.owns.length) L.push(`  owns     ${v.owns.join(', ')}`);
  L.push(`  model    ${v.model} · effort ${v.effort}  ·  turns ${v.turns || 0}`);
  if (v.activity) {
    L.push(`  activity ${v.activity.toolCalls || 0} tool calls · ${v.activity.subagentsStarted || 0} subagents${v.activity.lastTool ? ` · last ${v.activity.lastTool}` : ''} · ${v.activity.lastEventAt || ''}`);
  }
  if (v.idleMs !== undefined) L.push(`  idle     ${Math.round(v.idleMs / 1000)}s since the last engine event${v.stalled ? '  STALLED?' : ''}`);
  if (v.state === 'interrupted') L.push(`  the owning process is gone; continue with: zcode resume ${v.id}`);
  if (events.length) {
    L.push('  recent');
    for (const e of events) {
      const what = e.type === 'phase' ? `● ${e.phase}`
        : e.type === 'tool' ? `${e.phase} ${e.name}`
          : e.type === 'check' ? `check ${e.command}${e.phase === 'finished' ? (e.ok ? ' ok' : ' failed') : ''}`
            : e.type;
      L.push(`    ${String(e.t || '').slice(11, 19)}  ${what}`);
    }
  }
  return L.join('\n') + '\n';
}

module.exports = { phaseText, makeReporter, formatResult, formatSessionRow, formatSessionView, useColor };

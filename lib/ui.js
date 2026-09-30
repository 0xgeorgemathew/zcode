'use strict';
// Plain-mode terminal UI (lib/ui.js): one place for the "live feed" an
// operator watches on stderr while stdout carries only the answer.
//
// Visual contract (deliberate, terminal-native):
//   thinking   │ dimmed, every line prefixed "│ " - a quote block, clearly
//               not the answer
//   tool calls → started / ✓ ok / ✗ error, dimmed, one line each
//   mcp status ◇ connected / ✗ failed, dimmed
//   footer     one dimmed status line (model, effort, tool calls, time,
//               session) - the session id is there so a plain-mode caller
//               can pass it to --session without re-running with --json
//
// stdout is NEVER touched here. --quiet silences the whole feed.

function makePlainReporter({ quiet = false } = {}) {
  const tty = process.stderr.isTTY;
  const dim = (t) => (tty ? `\x1b[2m${t}\x1b[0m` : t);

  let thinkingOpen = false; // a thinking block is being streamed
  let atLineStart = true; // no "│ " written for this line yet

  const closeThinking = () => {
    if (thinkingOpen) {
      thinkingOpen = false;
      atLineStart = true;
      process.stderr.write('\n');
    }
  };

  const writeThinking = (delta) => {
    if (!thinkingOpen) {
      thinkingOpen = true;
      atLineStart = true;
    }
    for (const ch of delta) {
      if (atLineStart) {
        process.stderr.write(dim('│ '));
        atLineStart = false;
      }
      if (ch === '\n') {
        process.stderr.write('\n');
        atLineStart = true;
      } else {
        process.stderr.write(dim(ch));
      }
    }
  };

  const toolLine = (name, phase) => {
    if (phase === 'started' || phase === 'scheduled') {
      process.stderr.write(dim(`→ ${name} started\n`));
    } else if (phase === 'result') {
      process.stderr.write(dim(`✓ ${name} ok\n`));
    } else if (phase === 'error') {
      process.stderr.write(dim(`✗ ${name} error\n`));
    }
  };

  const mcpLine = (ev) => {
    if (ev.status === 'connected') {
      process.stderr.write(dim(`◇ mcp ${ev.name} connected\n`));
    } else if (ev.status === 'failed' || ev.status === 'timeout') {
      process.stderr.write(
        dim(`✗ mcp ${ev.name} ${ev.status}${ev.error ? ` (${ev.error})` : ''}\n`)
      );
    }
  };

  const onEvent = (ev) => {
    if (quiet) return;
    if (ev.type === 'stream' && ev.kind === 'reasoning_delta' && ev.delta) {
      writeThinking(ev.delta);
      return;
    }
    closeThinking();
    if (ev.type === 'stream' && ev.kind === 'text_delta' && ev.delta) {
      return; // the answer streams to stdout, not here
    }
    if (ev.type === 'tool' && ev.name) {
      toolLine(ev.name, ev.phase);
      return;
    }
    if (ev.type === 'mcp') {
      mcpLine(ev);
    }
  };

  const footer = ({ model, effort, toolCalls, durationMs, sessionId }) => {
    if (quiet) return;
    closeThinking();
    const parts = [
      model,
      `effort ${effort}`,
      typeof toolCalls === 'number' ? `${toolCalls} tool call${toolCalls === 1 ? '' : 's'}` : null,
      `${(durationMs / 1000).toFixed(1)}s`,
      sessionId ? sessionId.slice(0, 16) : null,
    ].filter(Boolean);
    process.stderr.write(dim(`  ${parts.join('  ·  ')}\n`));
  };

  return { onEvent, closeThinking, footer };
}

module.exports = { makePlainReporter };

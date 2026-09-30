'use strict';
// lib/commands/run.js — one-shot turn (DESIGN §9, §10), agent-first: NDJSON
// stream on stdout with --json (incl. reasoning_delta = thinking and tool
// lifecycle), reasoning mirrored to stderr live in plain mode, session
// continuity via --session, MCP/skills overlays applied per run.
const { executeTurn, TurnError } = require('../appserver.js');
const { bootstrap } = require('../bootstrap.js');

// Prompt: positional argv joined, else stdin (when piped).
function readPrompt(parsed) {
  if (parsed.prompts.length > 0) return parsed.prompts.join(' ');
  if (!process.stdin.isTTY) {
    return require('node:fs').readFileSync(0, 'utf8');
  }
  return '';
}

module.exports = async function run(parsed) {
  const flags = parsed.flags;
  const prompt = readPrompt(parsed);
  if (!prompt.trim()) {
    process.stderr.write('zcode: no prompt given (positional args or stdin).\n');
    process.exit(2);
  }

  const { client, scrub, overlay } = bootstrap({
    fresh: flags.fresh,
    mcpSpecs: flags.mcpSpecs,
    mcpInherit: flags.mcpInherit,
    skillsDirs: flags.skillsDirs,
    noSkills: flags.noSkills,
  });
  const workspacePath = flags.cwd;
  let streamedText = '';
  let reasoningOpen = false;
  const dim = (t) => (process.stderr.isTTY ? `\x1b[2m${t}\x1b[0m` : t);
  const closeReasoning = () => {
    if (reasoningOpen) {
      reasoningOpen = false;
      process.stderr.write('\n');
    }
  };
  const onEvent = flags.json
    ? (ev) => process.stdout.write(JSON.stringify(ev) + '\n')
    : (ev) => {
        if (ev.type === 'stream' && ev.kind === 'text_delta' && ev.delta) {
          closeReasoning();
          streamedText += ev.delta;
          process.stdout.write(ev.delta);
        } else if (
          ev.type === 'stream' &&
          ev.kind === 'reasoning_delta' &&
          ev.delta &&
          !flags.quiet
        ) {
          if (!reasoningOpen) {
            reasoningOpen = true;
            process.stderr.write(dim('[reasoning] '));
          }
          process.stderr.write(dim(ev.delta));
        } else if (ev.type === 'stream' && ev.kind === 'reasoning_end' && !flags.quiet) {
          closeReasoning();
        } else if (ev.type === 'tool' && ev.name && !flags.quiet) {
          closeReasoning();
          process.stderr.write(dim(`[tool] ${ev.name} ${ev.phase ?? ''}\n`));
        }
      };

  client.start();
  process.on('SIGINT', () => {
    client.kill();
    process.exit(130);
  });
  try {
    const turn = await executeTurn(client, {
      workspacePath,
      modelId: flags.model,
      effort: flags.effort,
      prompt,
      timeoutMs: flags.timeoutMs,
      resumeSessionId: flags.session || null,
      requiredMcp: overlay.mcp.added,
      onEvent,
    });
    if (flags.json) {
      const result = {
        type: 'result',
        ok: true,
        response: turn.response,
        model: turn.engineModel || flags.model,
        modelRequested: flags.model,
        effort: turn.engineReasoningLevel || flags.effort,
        effortRequested: flags.effort,
        mode: turn.mode,
        sessionId: turn.sessionId,
        resumed: turn.resumed,
        usage: turn.usage
          ? {
              inputTokens: turn.usage.inputTokens ?? null,
              outputTokens: turn.usage.outputTokens ?? null,
            }
          : null,
        reasoningChars: turn.reasoningText.length,
        toolCalls: turn.toolCallCount,
        toolEvents: turn.toolEvents,
        mcpServers: Object.keys(overlay.mcp.servers),
        skillsInjected: overlay.skills.injected,
        terminalStatus: turn.terminalStatus,
        streamingEvents: turn.streamingEvents,
        durationMs: turn.durationMs,
      };
      if (flags.includeReasoning) result.reasoning = turn.reasoningText;
      process.stdout.write(JSON.stringify(result) + '\n');
    } else {
      closeReasoning();
      if (!streamedText.trim()) process.stdout.write(turn.response);
      process.stdout.write('\n');
    }
    client.kill();
    process.exit(0);
  } catch (err) {
    client.kill();
    if (flags.json) {
      process.stdout.write(
        JSON.stringify({
          type: 'result',
          ok: false,
          error: err.kind || 'error',
          message: scrub(err.message),
        }) + '\n'
      );
    }
    if (err instanceof TurnError && err.kind === 'timeout') {
      process.stderr.write(`zcode: ${scrub(err.message)}\n`);
      process.exit(124);
    }
    process.stderr.write(`zcode: turn failed: ${scrub(err.message)}\n`);
    process.exit(5);
  }
};

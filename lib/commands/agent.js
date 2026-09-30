'use strict';
// lib/commands/agent.js — subagent-dispatching turn, verified programmatically
// (DESIGN §11): dispatch-forcing preamble, yolo run, then session/subagents
// RPC joined with the scratch agents dir. Never trusts the model's prose;
// exit 6 when no subagent ran or none ended "success".
const fs = require('node:fs');
const path = require('node:path');
const { executeTurn, TurnError } = require('../appserver.js');
const { bootstrap } = require('../bootstrap.js');

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// Join session/subagents ended items with <home>/.zcode/cli/agents/<parent>/
// agent_<uuid>/{metadata.json,output.txt} (all under the scratch HOME we own).
function collectSubagents({ client, sessionId, isolationHome, scrub }) {
  return client
    .request('session/subagents', { sessionId }, { timeoutMs: 15000 })
    .catch((err) => {
      throw new TurnError(`session/subagents failed: ${scrub(err.message)}`, {
        kind: 'subagents_rpc',
      });
    })
    .then((result) => {
      const items = (result && result.ended && result.ended.items) || [];
      const running = (result && result.running) || [];
      const agentsDir = path.join(
        isolationHome,
        '.zcode',
        'cli',
        'agents',
        sessionId
      );
      const out = [];
      for (const item of items) {
        const dir = path.join(agentsDir, `agent_${(item.agentId || '').replace(/^agent_/, '')}`);
        const metadata =
          readJsonSafe(path.join(dir, 'metadata.json')) || null;
        let output = null;
        try {
          output = fs.readFileSync(path.join(dir, 'output.txt'), 'utf8');
        } catch {
          /* subagent may not have flushed output */
        }
        out.push({
          agentId: item.agentId || (metadata && metadata.agentId) || null,
          childSessionId:
            item.childSessionId || (metadata && metadata.childSessionId) || null,
          profileId: (metadata && metadata.profileId) || item.subagentType || null,
          title: item.title || (metadata && metadata.description) || null,
          status: item.status || null,
          summary: item.summary || null,
          output,
          startedAt: item.startedAt || null,
          endedAt: item.endedAt || null,
          durationMs:
            item.startedAt && item.endedAt ? item.endedAt - item.startedAt : null,
        });
      }
      return { subagents: out, runningCount: running.length };
    });
}

module.exports = async function agent(parsed) {
  const flags = parsed.flags;
  const instructions = parsed.prompts.join(' ');
  if (!instructions.trim()) {
    process.stderr.write('zcode: agent needs instructions.\n');
    process.exit(2);
  }
  const profile = flags.profile || 'general-purpose';
  const prompt =
    `You MUST use the Agent tool (profileId: "${profile}") to accomplish the ` +
    `task below — do not do the work yourself. When the subagent finishes, ` +
    `report its agent id and result.\n\nTask: ${instructions}`;

  const { client, scrub, isolation, overlay } = bootstrap({
    fresh: flags.fresh,
    mcpSpecs: flags.mcpSpecs,
    mcpInherit: flags.mcpInherit,
    skillsDirs: flags.skillsDirs,
    noSkills: flags.noSkills,
  });
  client.start();
  process.on('SIGINT', () => {
    client.kill();
    process.exit(130);
  });
  const reporter = require('../ui.js').makePlainReporter({ quiet: flags.quiet });
  try {
    const turn = await executeTurn(client, {
      workspacePath: flags.cwd,
      modelId: flags.model,
      effort: flags.effort,
      prompt,
      timeoutMs: flags.timeoutMs,
      resumeSessionId: flags.session || null,
      requiredMcp: overlay.mcp.added,
      onEvent: (ev) => {
        if (flags.json) process.stdout.write(JSON.stringify(ev) + '\n');
        else reporter.onEvent(ev);
      },
    });

    const { subagents, runningCount } = await collectSubagents({
      client,
      sessionId: turn.sessionId,
      isolationHome: isolation.home,
      scrub,
    });

    const ok = subagents.length >= 1 && subagents.every((s) => s.status === 'success');

    if (flags.json) {
      process.stdout.write(
        JSON.stringify({
          type: 'result',
          ok,
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
          mcpServers: Object.keys(overlay.mcp.servers),
          skillsInjected: overlay.skills.injected,
          subagents,
          runningSubagents: runningCount,
          durationMs: turn.durationMs,
        }) + '\n'
      );
    } else if (!ok) {
      process.stdout.write(turn.response + '\n');
    } else {
      process.stdout.write(turn.response + '\n');
      reporter.footer({
        model: turn.engineModel || flags.model,
        effort: turn.engineReasoningLevel || flags.effort,
        toolCalls: turn.toolCallCount,
        durationMs: turn.durationMs,
        sessionId: turn.sessionId,
      });
      for (const s of subagents) {
        const secs = typeof s.durationMs === 'number' ? `  ${(s.durationMs / 1000).toFixed(1)}s` : '';
        process.stderr.write(
          (process.stderr.isTTY ? '\x1b[2m' : '') +
            `✓ subagent ${s.profileId}${secs}` +
            (process.stderr.isTTY ? '\x1b[0m' : '') + '\n'
        );
        if (s.summary) {
          process.stderr.write(
            (process.stderr.isTTY ? '\x1b[2m' : '') +
              `  ${s.summary.replace(/\s+/g, ' ').trim().slice(0, 200)}` +
              (process.stderr.isTTY ? '\x1b[0m' : '') + '\n'
          );
        }
      }
    }
    client.kill();
    if (!ok) {
      const why =
        subagents.length === 0
          ? 'no subagent was dispatched'
          : `subagent statuses: ${subagents.map((s) => s.status).join(', ')}`;
      process.stderr.write(`zcode: agent verification failed: ${why}\n`);
      process.exit(6);
    }
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
    process.stderr.write(`zcode: agent turn failed: ${scrub(err.message)}\n`);
    process.exit(5);
  }
}

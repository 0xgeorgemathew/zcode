#!/usr/bin/env node
'use strict';
// A scripted stand-in for `zcode.cjs app-server --stdio` (unit tests only;
// no model, no network). Speaks the NDJSON frames lib/appserver.js expects
// (DESIGN §9/§16). Behavior per session/send comes from the JSON file in
// FAKE_ENGINE_SCRIPT: {turns:[{response, write:{path,content}, writes:[{path,content}], delayMs,
// fail, hang, userInput, tool}], subagents:[…]}. The turn index persists in
// FAKE_ENGINE_STATE so a resumed session (a new engine process) continues
// the script. Every received method is appended to FAKE_ENGINE_LOG.
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

if (process.argv[2] !== 'app-server') {
  process.stdout.write('0.0.0-fake\n');
  process.exit(0);
}

const script = JSON.parse(fs.readFileSync(process.env.FAKE_ENGINE_SCRIPT, 'utf8'));
const logFile = process.env.FAKE_ENGINE_LOG;
const stateFile = process.env.FAKE_ENGINE_STATE;
const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
const log = (entry) => logFile && fs.appendFileSync(logFile, JSON.stringify(entry) + '\n');
const readState = () => {
  try {
    return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch {
    return { turn: 0, sessions: 0 };
  }
};
const writeState = (s) => fs.writeFileSync(stateFile, JSON.stringify(s));
let serverReq = 1;
let hangingTurn = null;

const event = (sessionId, type, payload, extra = {}) =>
  send({ method: 'session/event', params: { sessionId, type, payload, ...extra } });

function runTurn(sessionId) {
  const state = readState();
  const spec = script.turns[Math.min(state.turn, script.turns.length - 1)] || { response: 'ok' };
  state.turn++;
  writeState(state);
  log({
    turnStarted: state.turn,
    cwd: process.cwd(),
    home: process.env.HOME,
    zcode: {
      id: process.env.ZCODE_SESSION_ID,
      port: process.env.ZCODE_PORT,
      out: process.env.ZCODE_OUT,
      tmp: process.env.ZCODE_TMP,
    },
  });
  event(sessionId, 'turn.started', {}, { turnId: `t${state.turn}` });
  event(sessionId, 'session.updated', {
    type: 'model_request_started',
    providerId: 'zai-api',
    modelId: 'GLM-5.3-Flash',
    modelCall: { reasoning: { requestedLevel: 'max' } },
  });
  if (spec.userInput) {
    send({ id: `server-${++serverReq}`, method: 'interaction/requestUserInput', params: { message: spec.userInput } });
    return;
  }
  if (spec.grandchild) {
    // A tool subprocess that would write to the workspace later (must die
    // with the engine's process group on cancel).
    require('node:child_process').spawn('/bin/sh', ['-c', `sleep 1; touch '${spec.grandchild}'`], { stdio: 'ignore' });
  }
  if (spec.hang) {
    hangingTurn = sessionId;
    return;
  }
  setTimeout(() => {
    event(sessionId, 'model.streaming', { kind: 'reasoning_delta', delta: 'thinking…\n', done: false });
    if (spec.tool) {
      event(sessionId, 'tool.updated', { kind: 'started', toolName: spec.tool, toolCallId: 'tc1' });
      event(sessionId, 'tool.updated', { kind: 'result', toolName: spec.tool, toolCallId: 'tc1' });
    }
    for (const w of [spec.write, ...(spec.writes || [])].filter(Boolean)) {
      const target = path.join(process.cwd(), w.path);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, w.content);
    }
    if (spec.fail) {
      send({ method: 'v4/telemetry/event', params: { kind: 'turn.terminal', status: 'failed', result: { error: spec.fail } } });
      return;
    }
    event(sessionId, 'model.streaming', { kind: 'text_delta', delta: spec.response, done: true });
    event(sessionId, 'turn.completed', {
      response: spec.response,
      resultType: 'success',
      usage: { inputTokens: 100, outputTokens: 10 },
      toolCallCount: spec.tool ? 1 : 0,
    });
    send({ method: 'v4/telemetry/event', params: { kind: 'turn.terminal', status: 'success' } });
  }, spec.delayMs || 5);
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === undefined) {
    log({ reply: msg.id, error: msg.error ? msg.error.code : null });
    return; // a reply to one of our server requests
  }
  log({ method: msg.method, params: msg.params });
  const reply = (result) => send({ id: msg.id, result });
  switch (msg.method) {
    case 'session/create': {
      send({ id: `server-${++serverReq}`, method: 'session/requestRuntimePreferences', params: {} });
      const state = readState();
      state.sessions++;
      writeState(state);
      if (script.createHangs) return;
      reply({ session: { sessionId: `sess_fake${state.sessions}`, mode: 'build' } });
      return;
    }
    case 'session/resume':
      reply({ session: { sessionId: msg.params.sessionId, mode: 'build' } });
      return;
    case 'session/setMode':
      reply({});
      send({ method: 'state.updated', params: { patch: { mode: { current: msg.params.mode } } } });
      return;
    case 'session/subscribe':
    case 'mcp/list':
      reply(msg.method === 'mcp/list' ? { statuses: {} } : {});
      return;
    case 'session/send':
      reply({});
      runTurn(msg.params.sessionId);
      return;
    case 'session/stop':
      reply({});
      hangingTurn = null;
      return;
    case 'session/subagents':
      reply({ running: [], ended: { items: script.subagents || [] } });
      return;
    default:
      send({ id: msg.id, error: { code: -32601, message: 'fake: unknown method' } });
  }
});

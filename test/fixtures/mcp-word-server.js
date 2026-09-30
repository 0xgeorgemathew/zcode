#!/usr/bin/env node
'use strict';
// A REAL MCP stdio server (no SDK, zero deps) used by the functional tests:
// JSON-RPC over newline-delimited stdio per the MCP stdio transport. It
// exposes one tool, get_magic_word, which returns PAPAYA — letting a live
// test prove the engine actually spawned the server and called the tool.
const readline = require('node:readline');

const rl = readline.createInterface({ input: process.stdin });

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

rl.on('line', (line) => {
  if (!line.trim()) return;
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return;
  }
  if (req.id === undefined) return; // notifications (e.g. initialized) need no reply

  if (req.method === 'initialize') {
    const p = req.params || {};
    send({
      id: req.id,
      result: {
        protocolVersion: p.protocolVersion || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'word-server', version: '1.0.0' },
      },
    });
    return;
  }
  if (req.method === 'ping') {
    send({ id: req.id, result: {} });
    return;
  }
  if (req.method === 'tools/list') {
    send({
      id: req.id,
      result: {
        tools: [
          {
            name: 'get_magic_word',
            description: 'Returns the magic word. Takes no arguments.',
            inputSchema: { type: 'object', properties: {}, required: [] },
          },
        ],
      },
    });
    return;
  }
  if (req.method === 'tools/call') {
    const name = req.params && req.params.name;
    if (name === 'get_magic_word') {
      send({
        id: req.id,
        result: { content: [{ type: 'text', text: 'PAPAYA' }], isError: false },
      });
    } else {
      send({
        id: req.id,
        error: { code: -32602, message: `unknown tool: ${name}` },
      });
    }
    return;
  }
  send({ id: req.id, error: { code: -32601, message: `no such method: ${req.method}` } });
});

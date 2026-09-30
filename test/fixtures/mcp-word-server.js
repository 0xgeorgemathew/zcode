#!/usr/bin/env node
'use strict';
// A REAL MCP stdio server (no SDK, zero deps) used by the functional tests.
// Speaks BOTH stdio framings the wild offers — newline-delimited JSON and
// LSP-style Content-Length frames — replying in whichever the client used.
// (The ZCode engine's MCP client negotiates eras; a server that only speaks
// one framing flakes depending on which era the client picks.) It exposes
// one tool, get_magic_word, returning PAPAYA — a live test proves the
// engine spawned this server and the model called the tool.
let buf = Buffer.alloc(0);
let framing = null; // 'lsp' | 'lines'

function writeMsg(msg) {
  const body = JSON.stringify({ jsonrpc: '2.0', ...msg });
  if (framing === 'lsp') {
    process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  } else {
    process.stdout.write(body + '\n');
  }
}

function handle(req) {
  if (req.id === undefined) return; // notifications need no reply
  if (req.method === 'initialize') {
    const p = req.params || {};
    writeMsg({
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
    writeMsg({ id: req.id, result: {} });
    return;
  }
  if (req.method === 'tools/list') {
    writeMsg({
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
      writeMsg({
        id: req.id,
        result: { content: [{ type: 'text', text: 'PAPAYA' }], isError: false },
      });
    } else {
      writeMsg({ id: req.id, error: { code: -32602, message: `unknown tool: ${name}` } });
    }
    return;
  }
  writeMsg({ id: req.id, error: { code: -32601, message: `no such method: ${req.method}` } });
}

process.stdin.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  if (framing === null) {
    const head = buf.toString('utf8', 0, Math.min(buf.length, 32));
    if (head.startsWith('Content-Length:')) framing = 'lsp';
    else if (buf.includes(10)) framing = 'lines';
  }
  if (framing === 'lsp') {
    for (;;) {
      const s = buf.toString('utf8');
      const idx = s.indexOf('\r\n\r\n');
      if (idx === -1) return;
      const m = /Content-Length:\s*(\d+)/i.exec(s.slice(0, idx));
      if (!m) {
        buf = Buffer.alloc(0);
        return;
      }
      const len = parseInt(m[1], 10);
      const headerEnd = Buffer.byteLength(s.slice(0, idx), 'utf8') + 4;
      if (buf.length < headerEnd + len) return;
      const body = buf.slice(headerEnd, headerEnd + len).toString('utf8');
      buf = buf.slice(headerEnd + len);
      try {
        handle(JSON.parse(body));
      } catch {
        /* skip malformed frame */
      }
    }
  } else if (framing === 'lines') {
    for (;;) {
      const nl = buf.indexOf(10);
      if (nl === -1) return;
      const line = buf.slice(0, nl).toString('utf8').replace(/\r$/, '');
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      try {
        handle(JSON.parse(line));
      } catch {
        /* skip malformed line */
      }
    }
  }
});

'use strict';
// Per-session TCP port reservation. Parallel sessions that each start a dev
// or preview server must not fight over one port, so every session gets its
// own ($ZCODE_PORT): a lock file per port under <root>/ports/ (pid lock, so a
// dead session's port is reclaimed) plus a real bind probe, because the port
// may also be held by a process zcode knows nothing about.
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { rootDir } = require('./isolation.js');
const { claimLockFile } = require('./store.js');

const PORT_MIN = 41000;
const PORT_MAX = 48999;

// Resolves true when nothing is listening on `port` (all interfaces).
function portFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen({ port, exclusive: true }, () => server.close(() => resolve(true)));
  });
}

// Reserves a free port for this process; `preferred` (a resumed session's
// previous port) is tried first. Returns {port, release}, or null when the
// whole range is taken.
async function reservePort({ env = process.env, preferred = null } = {}) {
  const dir = path.join(rootDir(env), 'ports');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const span = PORT_MAX - PORT_MIN + 1;
  const start = Math.floor(Math.random() * span);
  const candidates = [];
  if (Number.isInteger(preferred) && preferred >= PORT_MIN && preferred <= PORT_MAX) candidates.push(preferred);
  for (let i = 0; i < span; i++) candidates.push(PORT_MIN + ((start + i) % span));
  for (const port of candidates) {
    const release = claimLockFile(path.join(dir, `${port}.lock`));
    if (!release) continue;
    if (await portFree(port)) return { port, release };
    release();
  }
  return null;
}

module.exports = { reservePort, portFree, PORT_MIN, PORT_MAX };

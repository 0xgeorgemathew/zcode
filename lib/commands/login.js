'use strict';
// lib/commands/login.js — read the API key from stdin and store it at
// <root>/credentials.json (mode 600, root mode 700) (DESIGN §5, §10).
// The key is never echoed. Output deliberately contains no key material.
const fs = require('node:fs');
const path = require('node:path');
const { rootDir } = require('../key.js');

module.exports = async function login() {
  if (process.stdin.isTTY) {
    process.stderr.write(
      'zcode login: paste your API key on stdin (it will not be echoed back):\n'
    );
  }
  let input = '';
  await new Promise((resolve) => {
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (input += c));
    process.stdin.on('end', resolve);
    process.stdin.on('error', resolve);
    if (process.stdin.isTTY) process.stdin.resume();
  });
  const key = input.trim();
  if (!key) {
    process.stderr.write('zcode login: no key received on stdin.\n');
    process.exit(2);
  }

  const root = rootDir(process.env);
  fs.mkdirSync(root, { recursive: true });
  fs.chmodSync(root, 0o700);
  const file = path.join(root, 'credentials.json');
  fs.writeFileSync(file, JSON.stringify({ apiKey: key }, null, 2) + '\n', {
    mode: 0o600,
  });
  fs.chmodSync(file, 0o600);
  // Invalidate the isolation stamp: the scratch key must be rebuilt from the
  // new credentials on the next run (key fingerprint change triggers it, but
  // be explicit when the credentials file is the source).
  const stamp = path.join(root, 'build-stamp.json');
  try {
    fs.rmSync(stamp, { force: true });
  } catch {
    /* nothing to invalidate */
  }
  process.stdout.write(`zcode login: key stored at ${file} (mode 600)\n`);
  process.exit(0);
};

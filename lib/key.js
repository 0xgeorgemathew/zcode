'use strict';
// API key resolution (DESIGN §5): ZAI_API_KEY env → ~/.zai-code/credentials.json
// ({"apiKey":"…"}, mode 600, written by `zai-code login`). The key is never
// printed, logged, or echoed by anything in this package.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// Root of zai-code's own state (scratch HOME lives under <root>/home).
function rootDir(env = process.env) {
  return env.ZAI_CODE_HOME || path.join(os.homedir(), '.zai-code');
}

function credentialsPath(env = process.env) {
  return path.join(rootDir(env), 'credentials.json');
}

class NoKeyError extends Error {
  constructor() {
    super('No API key configured. Run "zai-code login" or set ZAI_API_KEY.');
    this.code = 'ZAI_NO_KEY';
  }
}

// Reads {"apiKey": ...} from the credentials file; returns '' when absent.
function readCredentialsKey(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
  try {
    const parsed = JSON.parse(text);
    return typeof parsed.apiKey === 'string' ? parsed.apiKey : '';
  } catch {
    return '';
  }
}

// Sources, in order: ZAI_API_KEY (non-empty) → credentials.json.
// Throws NoKeyError when neither holds a key.
function resolveKey(env = process.env) {
  const fromEnv = (env.ZAI_API_KEY || '').trim();
  if (fromEnv) return fromEnv;
  const fromFile = readCredentialsKey(credentialsPath(env));
  if (fromFile) return fromFile;
  throw new NoKeyError();
}

module.exports = { resolveKey, credentialsPath, rootDir, NoKeyError };

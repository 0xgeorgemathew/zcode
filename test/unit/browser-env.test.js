'use strict';
// Browser requests get a usable answer, and the scratch HOME still sees the
// user's Playwright browsers and npm cache.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AppServerClient } = require('../../lib/appserver.js');
const { engineEnv } = require('../../lib/isolation.js');

function fakeClient() {
  const client = Object.create(AppServerClient.prototype);
  client.sent = [];
  client.child = { stdin: { write: (line) => client.sent.push(JSON.parse(line)) } };
  return client;
}

test('browserList answers with an empty list, browserExecute with a clear error', () => {
  const c = fakeClient();
  c._handleServerRequest({ id: 1, method: 'interaction/browserList', params: {} });
  c._handleServerRequest({ id: 2, method: 'interaction/browserExecute', params: {} });
  assert.deepEqual(c.sent[0], { id: 1, result: { browsers: [] } });
  assert.match(c.sent[1].error.message, /Playwright/);
});

test('engine env points Playwright and npm at the real HOME caches', () => {
  const real = fs.mkdtempSync(path.join(os.tmpdir(), 'zc-home-'));
  const cache = process.platform === 'darwin'
    ? path.join(real, 'Library', 'Caches', 'ms-playwright')
    : path.join(real, '.cache', 'ms-playwright');
  fs.mkdirSync(cache, { recursive: true });
  const env = engineEnv({ home: '/scratch', builtinProviderConfig: '/c', parentEnv: { HOME: real } });
  assert.equal(env.HOME, '/scratch');
  assert.equal(env.PLAYWRIGHT_BROWSERS_PATH, cache);
  assert.equal(env.npm_config_cache, path.join(real, '.npm'));
  const kept = engineEnv({ home: '/s', builtinProviderConfig: '/c', parentEnv: { HOME: real, PLAYWRIGHT_BROWSERS_PATH: '/mine' } });
  assert.equal(kept.PLAYWRIGHT_BROWSERS_PATH, '/mine');
});

'use strict';
// TDD — reasoning (thinking) visibility, agent-first (functional, live):
//  - --json stream carries reasoning_delta events (kind per engine wire)
//  - the final result reports reasoningChars (>0 at effort max)
//  - --include-reasoning puts the full text in the result
//  - plain mode mirrors reasoning to stderr while running (suppressible)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { cli, checkEngine, loadEnvKey } = require('../helpers/env.js');

const PROMPT = 'What is 17 * 23? Reason carefully, then reply with only the number.';

function preconditions() {
  const { engineOk } = checkEngine();
  assert.ok(engineOk, 'engine bundle must exist for the live test');
  assert.ok(loadEnvKey(), 'test API key must be loadable from .env');
}

test('LIVE --json: reasoning_delta events stream and the result reports reasoningChars', async () => {
  preconditions();
  const work = mkdtempSync(path.join(tmpdir(), 'zcode-reason-'));
  try {
    let last;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const { code, stdout, stderr } = await cli(
        ['--json', '--full', '--include-reasoning', '--cwd', work, PROMPT],
        { cwd: work, timeoutMs: 240000 }
      ).catch((err) => ({ code: -1, stdout: '', stderr: String(err.message) }));
      if (code === 2 || code === 3 || code === 4) {
        assert.fail(`config error exit ${code}: ${stderr.trim()}`);
      }
      if (code === 0) {
        const events = stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
        const result = events[events.length - 1];
        const reasoningDeltas = events.filter(
          (e) => e.type === 'stream' && e.kind === 'reasoning_delta'
        );
        if (
          result.ok &&
          (result.response || '').trim() === '391' &&
          reasoningDeltas.length >= 1 &&
          typeof result.reasoningChars === 'number' &&
          result.reasoningChars > 0 &&
          typeof result.reasoning === 'string' &&
          result.reasoning.length > 0
        ) {
          last = { pass: { result, events } };
          break;
        }
        last = {
          retryable: `unmet conditions: deltas=${reasoningDeltas.length} chars=${result.reasoningChars} response=${JSON.stringify(result.response).slice(0, 80)}`,
        };
      } else {
        last = { retryable: `exit ${code}: ${stderr.trim().slice(0, 400)}` };
      }
      if (attempt === 1) {
        console.log(`[retry] ${last.retryable}`);
        continue;
      }
      assert.fail(`second attempt failed: ${last.retryable}`);
    }
    const { result } = last.pass;
    assert.ok(result.reasoningChars > 0, 'reasoningChars > 0 at effort max');
    assert.ok(result.reasoning.length > 0, '--include-reasoning carries the text');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('LIVE plain mode: thinking streams as a distinct block; stdout stays the answer', async () => {
  preconditions();
  const work = mkdtempSync(path.join(tmpdir(), 'zcode-reason-plain-'));
  try {
    const { code, stdout, stderr } = await cli(['--cwd', work, PROMPT], {
      cwd: work,
      timeoutMs: 240000,
    });
    assert.equal(code, 0, stderr.trim().slice(0, 400));
    assert.equal(stdout.trim(), '391', 'stdout carries only the answer');
    const thinkingLines = stderr.split('\n').filter((l) => l.startsWith('│'));
    assert.ok(
      thinkingLines.length >= 1 && thinkingLines.join('').length > 10,
      'thinking mirrored to stderr as │-prefixed lines, visually distinct from the answer'
    );
    assert.match(stderr, /GLM-5\.3-Flash/, 'status footer carries the engine-reported model');
    assert.match(stderr, /effort max/, 'status footer carries the effort');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

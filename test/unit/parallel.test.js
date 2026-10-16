'use strict';
// Parallel-safe sessions: per-session environment and ports, .zcode/ never
// counted as a change, and --touch (allowed-but-reported edits).
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { setupFake, handback, invocation } = require('../helpers/fake.js');
const { execute, ExecError } = require('../../lib/executor.js');
const store = require('../../lib/store.js');
const { acquireLease, snapshot, diffSnapshots } = require('../../lib/workspace.js');
const { reservePort, PORT_MIN, PORT_MAX } = require('../../lib/ports.js');
const { buildTaskPrompt, sessionSection } = require('../../lib/contract.js');
const { rootDir } = require('../../lib/isolation.js');

let fake;
beforeEach(() => {
  fake = setupFake();
});
afterEach(() => fake.cleanup());

const done = (summary = 's') => handback({ status: 'done', summary });
const sends = () => fake.log().filter((e) => e.method === 'session/send').map((e) => e.params.content);

test('every session gets ZCODE_SESSION_ID / PORT / OUT / TMP, for the executor and for the checks', async () => {
  fake.setScript({ turns: [{ response: done() }] });
  const r = await execute(invocation(fake, {
    id: 'env-1',
    contract: {
      // Fails unless the check process sees all four variables with sane values.
      checks: ['test "$ZCODE_SESSION_ID" = env-1 && test "$ZCODE_PORT" -ge 41000 && test "$ZCODE_PORT" -le 48999 && test -d "$ZCODE_OUT" && test -d "$ZCODE_TMP"'],
    },
  }));
  assert.equal(r.status, 'completed', JSON.stringify(r.checks));

  const turn = fake.log().find((e) => e.turnStarted);
  assert.equal(turn.zcode.id, 'env-1');
  assert.equal(turn.zcode.out, path.join(fake.work, '.zcode', 'out', 'env-1'));
  assert.equal(turn.zcode.tmp, path.join(store.sessionDir('env-1'), 'tmp'));
  assert.ok(Number(turn.zcode.port) >= PORT_MIN && Number(turn.zcode.port) <= PORT_MAX);
  assert.ok(fs.statSync(turn.zcode.out).isDirectory());

  // Recorded in the session, and mentioned in the prompt.
  const rec = store.readSession('env-1');
  assert.equal(String(rec.port), turn.zcode.port);
  assert.equal(rec.out, turn.zcode.out);
  assert.deepEqual(r.sessionEnv, { port: rec.port, out: rec.out, tmp: rec.tmp });
  const [prompt] = sends();
  assert.match(prompt, /## Session environment/);
  assert.match(prompt, new RegExp(`ZCODE_PORT=${turn.zcode.port}`));
  assert.match(prompt, /ZCODE_OUT=/);
  assert.match(prompt, /ZCODE_TMP=/);
});

test('the Session environment prompt section is small and absent without a session', () => {
  const contract = { objective: 'x', scope: [], constraints: [], design: [], acceptance: [], checks: [], files: [], references: [], context: [], owns: [], touch: [] };
  const section = sessionSection({
    id: 'zc-1a2b3c4d', port: 48999,
    out: '/Users/dev/projects/site/.zcode/out/zc-1a2b3c4d', tmp: '/Users/dev/.zcode-cli/sessions/zc-1a2b3c4d/tmp',
  });
  assert.ok(Buffer.byteLength(section) <= 400, `${Buffer.byteLength(section)} bytes`);
  assert.equal(sessionSection(null), '');
  assert.ok(!/Session environment/.test(buildTaskPrompt(contract)));
});

test('parallel sessions get distinct ports while both are live; the port is freed afterwards', async () => {
  fake.setScript({ turns: [{ delayMs: 800, response: done() }] });
  const ports = [];
  const events = (e) => {};
  const [a, b] = await Promise.all([
    execute(invocation(fake, { id: 'p-a', contract: { owns: ['a/**'] } }), { onEvent: events }),
    execute(invocation(fake, { id: 'p-b', contract: { owns: ['b/**'] } }), { onEvent: events }),
  ]);
  ports.push(a.sessionEnv.port, b.sessionEnv.port);
  assert.notEqual(ports[0], ports[1]);
  const logged = fake.log().filter((e) => e.turnStarted).map((e) => e.zcode.id);
  assert.deepEqual(logged.sort(), ['p-a', 'p-b']);
  // Locks are released at the end of the session.
  const dir = path.join(rootDir(), 'ports');
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('reservePort: unique while held, reusable after release, skips ports in use by foreign processes', async () => {
  const held = [];
  for (let i = 0; i < 5; i++) held.push(await reservePort());
  const set = new Set(held.map((h) => h.port));
  assert.equal(set.size, 5);
  for (const h of held) assert.ok(h.port >= PORT_MIN && h.port <= PORT_MAX);

  const first = held[0];
  first.release();
  const again = await reservePort({ preferred: first.port });
  assert.equal(again.port, first.port, 'a released preferred port is reused');
  again.release();

  // A foreign listener on the preferred port is skipped.
  const server = net.createServer();
  const busy = await new Promise((resolve) => server.listen({ port: 0 }, () => resolve(server.address().port)));
  const inRange = await new Promise((resolve) => {
    const s = net.createServer();
    s.listen({ port: PORT_MIN + 123 }, () => resolve(s));
    s.on('error', () => resolve(null));
  });
  try {
    if (inRange) {
      const r = await reservePort({ preferred: PORT_MIN + 123 });
      assert.notEqual(r.port, PORT_MIN + 123);
      r.release();
    }
    assert.ok(busy > 0);
  } finally {
    server.close();
    if (inRange) inRange.close();
    for (const h of held) h.release();
  }
});

test('.zcode/ never counts as a change or a scope violation (non-git, nested, and git repos)', async () => {
  fake.setScript({
    turns: [{
      writes: [
        { path: '.zcode/out/x/shot.png', content: 'png' },
        { path: 'sub/.zcode/out/y.txt', content: 'y' },
        { path: 'src/a.txt', content: 'a' },
      ],
      response: done(),
    }],
  });
  const r = await execute(invocation(fake, { contract: { owns: ['src/**'] } }));
  assert.deepEqual(r.changes.files.map((f) => f.path), ['src/a.txt']);
  assert.deepEqual(r.scopeViolations, []);

  // Git repo that does NOT ignore .zcode: the snapshot never even lists it.
  const repo = path.join(fake.base, 'repo');
  fs.mkdirSync(repo);
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore' });
  git('init', '-q');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
  const before = snapshot(repo);
  fs.mkdirSync(path.join(repo, '.zcode', 'out'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.zcode', 'out', 'z.txt'), 'z');
  fs.mkdirSync(path.join(repo, 'pkg', '.zcode'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'pkg', '.zcode', 'w.txt'), 'w');
  fs.writeFileSync(path.join(repo, 'real.txt'), 'r');
  assert.equal(before.kind, 'git');
  assert.deepEqual(diffSnapshots(before, snapshot(repo)).map((f) => f.path), ['real.txt']);
});

test('--touch: edits are allowed but reported as touched, not as scope violations', async () => {
  fake.setScript({
    turns: [{
      writes: [{ path: 'src/a.txt', content: 'a' }, { path: 'styles/global.css', content: 'css' }, { path: 'other/x.txt', content: 'x' }],
      response: done(),
    }],
  });
  const r = await execute(invocation(fake, {
    touch: ['styles/global.css'],
    touchDisplay: ['styles/global.css'],
    contract: { owns: ['src/**'], touch: ['styles/global.css'] },
  }));
  assert.deepEqual(r.touched, ['styles/global.css']);
  assert.deepEqual(r.scopeViolations, ['other/x.txt'], 'only the un-touched, unowned file is a violation');
  const css = r.changes.files.find((f) => f.path === 'styles/global.css');
  assert.equal(css.touched, true);
  assert.equal(css.owned, false);
  const [prompt] = sends();
  assert.match(prompt, /You may also make minimal edits to:\n- styles\/global\.css/);

  // Brief carries `touched`.
  const { buildBrief } = require('../../lib/brief.js');
  assert.deepEqual(buildBrief(r).touched, ['styles/global.css']);
});

test('--touch alone (all edits touched) is not partial', async () => {
  fake.setScript({ turns: [{ write: { path: 'styles/global.css', content: 'css' }, response: done() }] });
  const r = await execute(invocation(fake, {
    touch: ['styles/*.css'],
    touchDisplay: ['styles/*.css'],
    contract: { owns: ['src/**'], touch: ['styles/*.css'], checks: ['true'] },
  }));
  assert.equal(r.status, 'completed');
  assert.deepEqual(r.touched, ['styles/global.css']);
});

test('--touch is refused (exit 7) while a live session owns a matching path; it reserves nothing', async () => {
  const owner = acquireLease({ id: 'owner', root: fake.work, owns: ['src/**'] });
  assert.ok(owner.ok);
  try {
    await assert.rejects(
      execute(invocation(fake, {
        id: 'toucher',
        touch: ['src/app.css'],
        touchDisplay: ['src/app.css'],
        contract: { owns: ['docs/**'], touch: ['src/app.css'] },
      })),
      (err) => err instanceof ExecError && err.exitCode === 7 && err.kind === 'conflict'
        && /--touch src\/app\.css is owned by running session\(s\) owner/.test(err.message)
    );
    assert.equal(store.readSession('toucher'), null, 'refused start leaves no record');

    // A touch outside everything the owner holds starts fine.
    fake.setScript({ turns: [{ response: done() }] });
    const ok = await execute(invocation(fake, { touch: ['styles/x.css'], touchDisplay: ['styles/x.css'], contract: { owns: ['docs/**'], touch: ['styles/x.css'] } }));
    assert.ok(ok.status);
  } finally {
    owner.release();
  }

  // Touch does not reserve: a live toucher never blocks an owner of the same path.
  const toucher = acquireLease({ id: 'toucher2', root: fake.work, owns: ['docs/**'], touch: ['src/app.css'] });
  assert.ok(toucher.ok);
  const claimer = acquireLease({ id: 'claimer', root: fake.work, owns: ['src/**'] });
  assert.ok(claimer.ok, 'owning a path some session may touch is allowed');
  claimer.release();
  toucher.release();
});

test('CLI: --touch and the contract "touch" key; refused with exit 7 against a live owner; task-only', async () => {
  const { cli } = require('../helpers/env.js');
  const run = (args) => cli(args, { cwd: fake.work, timeoutMs: 60000 });
  const owner = acquireLease({ id: 'cli-owner', root: fs.realpathSync(fake.work), owns: ['src/**'] });
  assert.ok(owner.ok);
  try {
    const flag = await run(['task', '--touch', 'src/app.css', '--owns', 'docs/**', 'Do it']);
    assert.equal(flag.code, 7, flag.stderr);
    assert.match(flag.stderr, /--touch src\/app\.css is owned by running session\(s\) cli-owner/);

    const file = path.join(fake.base, 'c.json');
    fs.writeFileSync(file, JSON.stringify({ objective: 'x', owns: ['docs/**'], touch: ['src/app.css'] }));
    const viaContract = await run(['task', '--task', file]);
    assert.equal(viaContract.code, 7, viaContract.stderr);
  } finally {
    owner.release();
  }
  const notTask = await run(['run', '--touch', 'x', 'hi']);
  assert.equal(notTask.code, 2);
  assert.match(notTask.stderr, /--touch is only valid with "zcode task"/);
  const outside = await run(['task', '--touch', '../elsewhere', 'Do it']);
  assert.equal(outside.code, 2);
  assert.match(outside.stderr, /--touch "\.\.\/elsewhere" is outside the workspace/);
});

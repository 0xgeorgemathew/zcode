'use strict';
// Decisions stay with the orchestrator (decisions, structured questions,
// dedupe, preflight), units (one session, several subagents) and visual
// verification by zcode.
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { setupFake, handback, invocation } = require('../helpers/fake.js');
const { execute } = require('../../lib/executor.js');
const store = require('../../lib/store.js');
const { buildBrief } = require('../../lib/brief.js');
const {
  normalizeContract, buildTaskPrompt, buildRepairPrompt, parseHandback, parseUnit, ContractError,
} = require('../../lib/contract.js');
const { buildContract } = require('../../lib/taskspec.js');
const { parseArgv } = require('../../bin/zcode.js');

const BIN = path.join(__dirname, '..', '..', 'bin', 'zcode.js');
let fake;
beforeEach(() => {
  fake = setupFake();
});
afterEach(() => fake.cleanup());

const sends = () => fake.log().filter((e) => e.method === 'session/send').map((e) => e.params.content);
const done = (extra = {}) => handback({ status: 'done', summary: 'ok', ...extra });
const cli = (args) => spawnSync(process.execPath, [BIN, ...args], { cwd: fake.work, env: process.env, encoding: 'utf8' });

// --- decisions ----------------------------------------------------------------

test('decisions render as the binding section, with design as an alias in the same section', () => {
  const c = normalizeContract({ objective: 'O', decisions: ['Use plan names A/B'], design: ['Tokens from tokens.css'] });
  const p = buildTaskPrompt(c);
  assert.match(p, /## Binding decisions \(made by the orchestrator: implement exactly\)\n- Use plan names A\/B\n- Tokens from tokens\.css\n/);
  assert.equal(p.match(/## Binding decisions/g).length, 1);
  assert.doesNotMatch(buildTaskPrompt(normalizeContract({ objective: 'O' })), /Binding decisions/);
  // Protocol keeps its guidance and gains the no-guessing rule.
  assert.match(p, /Do not make product or design decisions the orchestrator has not made/);
  assert.match(p, /do not guess: if it blocks the work, report "blocked" with a structured question/);
  assert.match(p, /"decisions": \[\{"what"/);
});

test('--decision and --decisions @file feed one list; contract-JSON @file entries resolve next to the contract', () => {
  const parsed = parseArgv(['task', '--decision', 'D1', '--decisions', '@x.md', '--decision', 'D2', 'go']);
  assert.deepEqual(parsed.flags.decisions, ['D1', '@x.md', 'D2']);

  const dir = fs.mkdtempSync(path.join(fake.base, 'spec-'));
  fs.writeFileSync(path.join(dir, 'decide.md'), 'Pricing is monthly only\n');
  fs.writeFileSync(path.join(dir, 'ctx.md'), 'Background notes\n');
  const c = buildContract({
    base: { objective: 'O', decisions: ['@decide.md'], context: ['@ctx.md'] },
    baseDir: dir,
    additions: { decisions: ['D1'] },
    cwd: fake.work,
  });
  assert.deepEqual(c.decisions, ['Pricing is monthly only', 'D1']);
  assert.deepEqual(c.context, ['Background notes']);
  assert.throws(() => buildContract({ base: { objective: 'O', decisions: ['@missing.md'] }, baseDir: dir, cwd: fake.work }), /could not be read/);
});

test('structured and plain-string questions both parse; structured keep options and recommend', () => {
  const { handback: h } = parseHandback(handback({
    status: 'blocked',
    summary: 's',
    questions: ['plain?', { q: 'Annual plan?', options: ['A yes', 'B no'], recommend: 'B no' }, { q: 'bare' }],
    decisions: [{ what: 'used em dashes', why: 'conservative' }, 'string decision'],
  }));
  assert.deepEqual(h.questions, [
    'plain?',
    { q: 'Annual plan?', options: ['A yes', 'B no'], recommend: 'B no' },
    { q: 'bare' },
  ]);
  assert.deepEqual(h.decisions, [{ what: 'used em dashes', why: 'conservative' }, { what: 'string decision', why: '' }]);
});

test('a blocked handback with a structured question surfaces in the result and the brief', async () => {
  const q = { q: 'Which CTA?', options: ['A Start', 'B Buy'], recommend: 'A Start' };
  fake.setScript({ turns: [{ response: handback({ status: 'blocked', summary: 'need CTA', questions: [q] }) }] });
  const r = await execute(invocation(fake, { id: 'q-1' }));
  assert.equal(r.status, 'blocked');
  assert.deepEqual(r.questions, [q]);
  assert.deepEqual(buildBrief(r).questions, [q]);
});

test('decisions the executor made reach the result and the brief', async () => {
  const decisions = [{ what: 'kept existing copy', why: 'no spec' }];
  fake.setScript({ turns: [{ response: done({ decisions }) }] });
  const r = await execute(invocation(fake, { id: 'd-1', contract: { checks: ['true'] } }));
  assert.equal(r.status, 'completed');
  assert.deepEqual(r.decisions, decisions);
  assert.deepEqual(buildBrief(r).decisions, decisions);
  assert.ok(!('decisions' in buildBrief({ ...r, decisions: [] })));
});

// --- dedupe -------------------------------------------------------------------

test('a --file that is also inlined with --context @file appears once, as context', () => {
  const spec = path.join(fake.work, 'spec.md');
  fs.writeFileSync(spec, 'THE SPEC\n');
  const parsed = parseArgv(['task', '--file', 'spec.md', '--file', 'other.js', '--context', `@${spec}`, '--context', 'same', '--context', 'same', 'go']);
  const c = buildContract({
    objective: 'O',
    cwd: fake.work,
    additions: { files: parsed.flags.file, context: parsed.flags.context, acceptance: ['a', 'a'] },
  });
  // --file resolves against --cwd, the @file against where zcode was run.
  const viaCwd = buildContract({ objective: 'O', cwd: fake.work, additions: { files: ['spec.md', 'other.js'], context: [`@${spec}`] } });
  assert.deepEqual(viaCwd.files, ['other.js']);
  assert.deepEqual(viaCwd.context, ['THE SPEC']);
  assert.deepEqual(c.context.filter((x) => x === 'same'), ['same']);
  assert.deepEqual(c.acceptance, ['a']);
  const p = buildTaskPrompt(viaCwd);
  assert.equal(p.match(/THE SPEC/g).length, 1);
  assert.doesNotMatch(p, /- spec\.md/);
});

// --- preflight ----------------------------------------------------------------

test('preflight: blocked with questions, no checks, read-only prompt, preflight recorded', async () => {
  const q = { q: 'Annual billing?', options: ['A yes', 'B no'], recommend: 'B no' };
  fake.setScript({ turns: [{ response: handback({ status: 'blocked', summary: 'open questions', questions: [q] }) }] });
  const r = await execute(invocation(fake, {
    id: 'pf-1', preflight: true, contract: { checks: ['touch should-not-run'], visual: ['looks right'] },
  }));
  assert.equal(r.status, 'blocked');
  assert.deepEqual(r.questions, [q]);
  assert.equal(r.preflight, true);
  assert.equal(buildBrief(r).preflight, true);
  assert.deepEqual(r.checks, []);
  assert.ok(!fs.existsSync(path.join(fake.work, 'should-not-run')));
  assert.equal(store.readSession('pf-1').preflight, true);
  const [prompt] = sends();
  assert.match(prompt, /## Preflight \(read-only\)/);
  assert.match(prompt, /Make NO edits/);
  assert.doesNotMatch(prompt, /## Acceptance checks/);
});

test('preflight: no open questions completes with that summary', async () => {
  fake.setScript({ turns: [{ response: done({ summary: 'nothing open, all clear' }) }] });
  const r = await execute(invocation(fake, { id: 'pf-2', preflight: true, contract: { checks: ['false'] } }));
  assert.equal(r.status, 'completed');
  assert.equal(r.ok, true);
  assert.equal(r.summary, 'no open questions');
  assert.equal(r.checks.length, 0);
  assert.ok(r.notVerified.some((n) => /preflight/.test(n)));
});

test('preflight: writing any file fails with kind preflight_wrote', async () => {
  fake.setScript({ turns: [{ write: { path: 'src/oops.txt', content: 'x' }, response: done() }] });
  const r = await execute(invocation(fake, { id: 'pf-3', preflight: true }));
  assert.equal(r.status, 'failed');
  assert.equal(r.error.kind, 'preflight_wrote');
  assert.match(r.issues[0], /src\/oops\.txt/);
  assert.equal(buildBrief(r).error.kind, 'preflight_wrote');
});

test('resume of a preflight session switches to execution: answers + full protocol, checks run', async () => {
  fake.setScript({
    turns: [
      { response: handback({ status: 'blocked', summary: 'q', questions: [{ q: 'Annual?', options: ['A', 'B'] }] }) },
      { write: { path: 'out.txt', content: 'hi' }, response: done({ summary: 'built' }) },
    ],
  });
  const first = await execute(invocation(fake, {
    id: 'pf-4', preflight: true, contract: { objective: 'Build it', checks: ['test -f out.txt'] },
  }));
  assert.equal(first.status, 'blocked');
  assert.equal(first.checks.length, 0);

  const settings = require('../../lib/executor.js').readSettings('pf-4');
  assert.equal(settings.preflight, true);
  const second = await execute({
    ...invocation(fake, { id: 'pf-4', contract: { objective: 'Build it', checks: ['test -f out.txt'] } }),
    ...settings,
    resume: { message: 'Go with B' },
    contract: JSON.parse(fs.readFileSync(path.join(store.sessionDir('pf-4'), 'task.json'), 'utf8')),
  });
  assert.equal(second.status, 'completed', JSON.stringify(second.issues));
  assert.equal(second.preflight, undefined);
  assert.equal(second.checks.length, 1);
  assert.equal(store.readSession('pf-4').preflight, false);
  assert.equal(require('../../lib/executor.js').readSettings('pf-4').preflight, false);
  const prompt = sends()[1];
  assert.match(prompt, /## Handback/);
  assert.match(prompt, /## How to work/);
  assert.match(prompt, /## Acceptance checks/);
  assert.doesNotMatch(prompt, /## Preflight \(read-only\)/);
  assert.match(prompt, /## Answers to your preflight questions[\s\S]*Go with B/);
});

test('--preflight is a task-only start flag', () => {
  const r = cli(['resume', 'x', '--preflight']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--preflight/);
  assert.equal(parseArgv(['task', '--preflight', 'go']).flags.preflight, true);
});

// --- units --------------------------------------------------------------------

test('--unit parses "name: objective [owns a,b]"; contract units accept objects', () => {
  assert.deepEqual(parseUnit('hero: build the hero [owns src/hero/**, src/hero.css]'), {
    name: 'hero', objective: 'build the hero', owns: ['src/hero/**', 'src/hero.css'],
  });
  assert.deepEqual(parseUnit('faq: write the faq'), { name: 'faq', objective: 'write the faq' });
  assert.throws(() => parseUnit('no colon here'), ContractError);
  const c = normalizeContract({ objective: 'O', units: [{ name: 'a', objective: 'do a', owns: 'src/a/**' }] }, { units: ['b: do b'] });
  assert.deepEqual(c.units, [{ name: 'a', objective: 'do a', owns: ['src/a/**'] }, { name: 'b', objective: 'do b' }]);
  assert.throws(() => normalizeContract({ objective: 'O' }, { units: ['a: x', 'a: y'] }), /duplicate unit name/);
  assert.throws(() => normalizeContract({ objective: 'O', units: [{ name: 'a' }] }), /name and an objective/);
  assert.equal(parseArgv(['task', '--unit', 'a: b', '--unit', 'c: d', 'go']).flags.units.length, 2);
});

test('unit owns must lie within the session owns and be disjoint', () => {
  const build = (owns, units) => buildContract({ objective: 'O', cwd: fake.work, additions: { owns, units } });
  assert.equal(build(['src/**'], ['a: x [owns src/a/**]', 'b: y [owns src/b/**]']).units.length, 2);
  assert.equal(build([], ['a: x [owns anywhere/**]']).units.length, 1);
  assert.throws(() => build(['src/**'], ['a: x [owns lib/a/**]']), /unit "a" owns "lib\/a\/\*\*", which is outside/);
  assert.throws(() => build(['src/**'], ['a: x [owns src/a/**]', 'b: y [owns src/a/b/**]']), /overlapping owns/);
});

test('unit problems exit 2 with one line before anything starts', () => {
  const outside = cli(['task', '--owns', 'src/**', '--unit', 'a: x [owns lib/**]', 'go']);
  assert.equal(outside.status, 2);
  assert.match(outside.stderr, /^zcode: unit "a" owns "lib\/\*\*"/);
  assert.equal(outside.stderr.trim().split('\n').length, 1);
  const overlap = cli(['task', '--unit', 'a: x [owns src/**]', '--unit', 'b: y [owns src/b/**]', 'go']);
  assert.equal(overlap.status, 2);
  assert.match(overlap.stderr, /overlapping owns/);
  assert.deepEqual(fake.log(), []);
});

test('units render as a Units section; unit claims land in notVerified and the brief', async () => {
  const c = normalizeContract({ objective: 'O' }, { owns: ['src/**'], units: ['hero: build hero [owns src/hero/**]', 'faq: build faq'] });
  const p = buildTaskPrompt(c);
  assert.match(p, /## Units\nDispatch each unit below to its own subagent \(Agent tool\)[^\n]*run independent units in parallel|## Units\n[^\n]*Run independent units in parallel/);
  assert.match(p, /- hero: build hero \(owns: src\/hero\/\*\*\)\n- faq: build faq\n/);
  assert.doesNotMatch(buildTaskPrompt(normalizeContract({ objective: 'O' })), /## Units/);

  const units = [{ name: 'hero', status: 'done', note: 'ok' }, { name: 'faq', status: 'partial', note: 'no icons' }];
  fake.setScript({ turns: [{ response: done({ units }) }] });
  const r = await execute(invocation(fake, { id: 'u-1', contract: { checks: ['true'], units: c.units } }));
  assert.equal(r.status, 'completed');
  assert.deepEqual(r.units, units);
  assert.ok(r.notVerified.some((n) => /unit results are executor claims: hero done, faq partial/.test(n)));
  assert.deepEqual(buildBrief(r).units, units);
});

// --- visual -------------------------------------------------------------------

const visualContract = (extra = {}) => normalizeContract({ objective: 'O', visual: ['CTA visible above the fold'], ...extra });

test('--visual / --viewport / --serve parse; viewports default and validate', () => {
  const parsed = parseArgv(['task', '--visual', 'a', '--visual', 'b', '--viewport', '375x667', '--serve', 'npm run dev -- --port $ZCODE_PORT', 'go']);
  assert.deepEqual(parsed.flags.visual, ['a', 'b']);
  assert.deepEqual(parsed.flags.viewports, ['375x667']);
  assert.equal(parsed.flags.serve, 'npm run dev -- --port $ZCODE_PORT');
  assert.throws(() => normalizeContract({ objective: 'O' }, { viewports: ['wide'] }), /must look like 390x844/);
  const r = cli(['task', '--visual', 'x', '--viewport', 'wide', 'go']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /viewport "wide"/);
});

test('Visual verification section: defaults, custom viewports, serve command, ports and shots', () => {
  const session = { id: 's', port: 41000, out: '/o', tmp: '/t' };
  const def = buildTaskPrompt(visualContract(), { session });
  assert.match(def, /## Visual verification/);
  assert.match(def, /\(390x844, 1440x900\)/);
  assert.match(def, /\$ZCODE_PORT/);
  assert.match(def, /\$ZCODE_OUT\/shots/);
  assert.match(def, /- CTA visible above the fold/);
  assert.match(def, /"criterion", "viewport", "met", "note", "shot"/);
  const custom = buildTaskPrompt(visualContract({ viewports: ['375x667'], serve: 'npm run preview' }), { session });
  assert.match(custom, /\(375x667\)/);
  assert.match(custom, /`npm run preview` on \$ZCODE_PORT/);
});

test('no visual flags: the prompt has no visual section and is unchanged by empty visual keys', () => {
  const plain = normalizeContract({ objective: 'O', owns: ['src/**'] }, { checks: ['npm test'] });
  const withEmpty = normalizeContract({ objective: 'O', owns: ['src/**'], visual: [], viewports: [], units: [], decisions: [] }, { checks: ['npm test'] });
  assert.equal(buildTaskPrompt(plain), buildTaskPrompt(withEmpty));
  assert.doesNotMatch(buildTaskPrompt(plain), /Visual verification|## Units|Preflight/);
  // viewports alone (no criteria) render nothing.
  assert.doesNotMatch(buildTaskPrompt(normalizeContract({ objective: 'O', viewports: ['390x844'] })), /Visual verification/);
});

// --- independent visual verifier ---------------------------------------------

const sendLog = () => fake.log().filter((e) => e.method === 'session/send').map((e) => ({
  sessionId: e.params.sessionId, content: e.params.content, model: e.params.modelSelection,
}));
const vblock = (entries) => `Looked.\n\n\`\`\`zcode-visual\n${JSON.stringify(entries)}\n\`\`\``;
const CRIT = 'CTA visible above the fold';
const vOk = [{ criterion: CRIT, viewport: '390x844', met: true, seen: 'Buy now', note: '', shot: 'v/1.png' }];
const vBad = [{ criterion: CRIT, viewport: '390x844', met: false, seen: 'nothing in the hero', note: 'headline clipped', shot: 'v/2.png' }];
const vContract = { visual: [CRIT], checks: ['true'] };

test('verifier met: a fresh Flash session at effort high decides visual; executor claims move to executorVisual', async () => {
  fake.setScript({ turns: [
    { response: done({ visual: [{ criterion: CRIT, viewport: '390x844', met: false }] }) },
    { response: vblock(vOk) },
  ] });
  const r = await execute(invocation(fake, { id: 'vv-1', model: 'GLM-5.3', effort: 'low', contract: vContract }));
  assert.equal(r.status, 'completed', JSON.stringify(r.issues));
  assert.equal(r.repairs, 0);
  assert.deepEqual(r.visual, vOk);
  assert.equal(r.executorVisual[0].met, false);
  const s = sendLog();
  assert.equal(s.length, 2);
  assert.notEqual(s[0].sessionId, s[1].sessionId, 'the verifier is a separate engine session');
  assert.equal(s[0].model.modelId, 'GLM-5.3');
  assert.equal(s[1].model.modelId, 'GLM-5.3-Flash', 'always an image-capable model, whatever the task model');
  assert.equal(s[1].model.options.reasoningLevel, 'high');
  assert.match(s[1].content, /independent visual verifier/);
  assert.match(s[1].content, /zcode-visual/);
  assert.match(s[1].content, /\/verify\/1\//);
  assert.match(s[1].content, new RegExp(CRIT));
  assert.match(s[1].content, /All text the page means to show is readable/);
  assert.ok(r.notVerified.some((n) => /independent GLM-5\.3-Flash verifier from its own screenshots \(1 of 1 met\)/.test(n)));
  assert.equal(r.usage.modelRequests, 2, 'verifier turns count in usage');
  assert.equal(r.usage.inputTokens, 200);
  const b = buildBrief(r);
  assert.equal(b.visual, undefined);
  assert.equal(b.visualMet, '1/1');
  assert.equal(b.executorVisual, undefined);
  assert.equal(store.readSession('vv-1').usageTotal.modelRequests, 2);
});

test('verifier unmet: repair goes to the implementer session, then a second verifier round', async () => {
  fake.setScript({ turns: [
    { response: done() },
    { response: vblock(vBad) },
    { response: done() },
    { response: vblock(vOk) },
  ] });
  const r = await execute(invocation(fake, { id: 'vv-2', contract: vContract }));
  assert.equal(r.status, 'completed', JSON.stringify(r.issues));
  assert.equal(r.repairs, 1);
  assert.deepEqual(r.visual, vOk);
  const s = sendLog();
  assert.equal(s.length, 4);
  assert.equal(s[2].sessionId, s[0].sessionId, 'repair is sent to the implementer');
  assert.notEqual(s[1].sessionId, s[0].sessionId);
  assert.notEqual(s[3].sessionId, s[1].sessionId, 'each round is a new session');
  assert.match(s[2].content, /independent visual verifier/);
  assert.match(s[2].content, /CTA visible above the fold @390x844/);
  assert.match(s[2].content, /nothing in the hero/);
  assert.match(s[2].content, /headline clipped/);
  assert.match(s[2].content, /v\/2\.png/);
  assert.match(s[3].content, /\/verify\/2\//);
  assert.deepEqual(store.readEvents('vv-2', { tail: 50 }).filter((e) => e.type === 'phase').map((e) => e.phase + (e.round || '')),
    ['starting', 'executing', 'checking', 'verifying1', 'repairing', 'checking', 'verifying2']);
});

test('verifier unmet after the repair budget: partial with a visual issue and the seen text in the brief', async () => {
  fake.setScript({ turns: [{ response: done() }, { response: vblock(vBad) }, { response: done() }, { response: vblock(vBad) }] });
  const r = await execute(invocation(fake, { id: 'vv-3', maxRepairs: 1, contract: vContract }));
  assert.equal(r.status, 'partial');
  assert.equal(r.repairs, 1);
  assert.ok(r.issues.some((i) => /^visual criteria unmet: CTA visible above the fold @390x844/.test(i)));
  const b = buildBrief(r);
  assert.equal(b.visual[0].seen, 'nothing in the hero');
  assert.equal(b.visualMet, '0/1');
});

test('no zcode-visual block twice: retried once, then partial with "visual not verified" (no repair)', async () => {
  fake.setScript({ turns: [{ response: done() }, { response: 'I could not.' }, { response: 'still nothing' }] });
  const r = await execute(invocation(fake, { id: 'vv-4', contract: vContract }));
  assert.equal(r.status, 'partial');
  assert.equal(r.repairs, 0);
  assert.equal(sendLog().length, 3);
  assert.equal(r.visual[0].met, null);
  assert.match(r.visual[0].note, /^not verified: /);
  assert.ok(r.issues.some((i) => /^visual not verified: /.test(i)));
  assert.equal(buildBrief(r).visual[0].met, null);
});

test('verifier retry: a block on the second attempt is accepted', async () => {
  fake.setScript({ turns: [{ response: done() }, { response: 'oops' }, { response: vblock(vOk) }] });
  const r = await execute(invocation(fake, { id: 'vv-5', contract: vContract }));
  assert.equal(r.status, 'completed', JSON.stringify(r.issues));
  assert.equal(sendLog().length, 3);
});

test('a verifier that edits workspace files is an issue, not a scope violation', async () => {
  fake.setScript({ turns: [{ response: done() }, { write: { path: 'src/oops.txt', content: 'x' }, response: vblock(vOk) }] });
  const r = await execute(invocation(fake, { id: 'vv-6', owns: ['docs/**'], contract: { ...vContract, owns: ['docs/**'] } }));
  assert.equal(r.status, 'completed', JSON.stringify(r.issues));
  assert.deepEqual(r.scopeViolations, []);
  assert.ok(r.issues.some((i) => /^verifier edited files: src\/oops\.txt/.test(i)));
});

test('a declared criterion the verifier omits is not verified', async () => {
  fake.setScript({ turns: [{ response: done() }, { response: vblock([{ criterion: 'something else', viewport: '1x1', met: true, seen: 'x' }]) }] });
  const r = await execute(invocation(fake, { id: 'vv-7', contract: vContract }));
  assert.equal(r.status, 'partial');
  assert.ok(r.issues.some((i) => /visual not verified: CTA visible above the fold/.test(i)));
});

test('no visual criteria: no verifier session, one turn', async () => {
  fake.setScript({ turns: [{ response: done() }] });
  const r = await execute(invocation(fake, { id: 'vv-8', contract: { checks: ['true'] } }));
  assert.equal(r.status, 'completed');
  assert.equal(sendLog().length, 1);
  assert.equal(r.verifier, undefined);
});

test('the implementer prompt varies with image support', async () => {
  const c = visualContract({ serve: 'npm run preview' });
  const blind = buildTaskPrompt(c, { canSeeImages: false });
  assert.match(blind, /You cannot see images\. Do not judge screenshots or report `visual`; an independent vision verifier will\./);
  assert.match(blind, /non-zero box inside the viewport/);
  assert.match(blind, /npm run preview/);
  assert.doesNotMatch(blind, /capture screenshots/);
  const sees = buildTaskPrompt(c, { canSeeImages: true });
  assert.match(sees, /you can look at screenshots/);
  assert.match(sees, /independent verifier will re-judge/);
  assert.doesNotMatch(sees, /cannot see images/);

  fake.setScript({ turns: [{ response: done() }] });
  await execute(invocation(fake, { id: 'vv-9', model: 'GLM-5.3', contract: { visual: [CRIT] }, checks: [] }));
  assert.match(sendLog()[0].content, /You cannot see images/);
  fake.resetEngineState();
  fake.setScript({ turns: [{ response: done() }] });
  await execute(invocation(fake, { id: 'vv-10', model: 'GLM-5.3-Flash', contract: { visual: [CRIT] }, checks: [] }));
  assert.match(sendLog().filter((x) => x.content.startsWith('You are Zcode')).pop().content, /you can look at screenshots/);
});

test('repair prompt lists verifier entries; without visual it is unchanged', () => {
  const text = buildRepairPrompt([{ command: 'x', output: 'boom', exitCode: 1 }], {
    attempt: 1, maxRepairs: 2, visual: [{ criterion: 'v', viewport: '390x844', seen: 'hello', note: 'cut off', shot: 'a.png' }],
  });
  assert.match(text, /### `x` \(exit 1\)[\s\S]*verifier found unmet[\s\S]*- v @390x844 - saw: "hello" \| cut off \| shot: a\.png/);
  const t = buildRepairPrompt([{ command: 'npm test', output: 'fail', exitCode: 1 }], { attempt: 1, maxRepairs: 2 });
  assert.match(t, /^Zcode ran the acceptance checks and one failed \(repair attempt 1 of 2\):/);
  assert.doesNotMatch(t, /isual/);
});

test('parseVisualBlock is lenient: last block wins, met strings normalize, junk is an error', () => {
  const { parseVisualBlock } = require('../../lib/verify.js');
  const p = parseVisualBlock('```zcode-visual\n[]\n```\n```zcode-visual\n[{"criterion":"a","met":"yes","seen":"x"},{"criterion":"b","met":"maybe"},5]\n```');
  assert.deepEqual(p.entries.map((e) => e.met), [true, null]);
  assert.match(parseVisualBlock('nothing').error, /no zcode-visual block/);
  assert.match(parseVisualBlock('```zcode-visual\n{bad\n```').error, /invalid JSON/);
  assert.equal(parseVisualBlock('```zcode-visual\n{"visual":[{"criterion":"a","met":false}]}\n```').entries[0].met, false);
});

// --- Flash by default everywhere ----------------------------------------------

test('every entry point defaults to GLM-5.3-Flash; plan sessions inherit it; the plan may still override', () => {
  const { buildInvocation } = require('../../lib/commands/exec.js');
  for (const cmd of ['run', 'task', 'agent']) {
    assert.equal(buildInvocation(parseArgv([cmd, 'go'])).model, 'GLM-5.3-Flash', cmd);
  }
  const plans = require('../../lib/plan.js');
  const file = path.join(fake.base, 'plan.json');
  fs.writeFileSync(file, JSON.stringify({ cwd: fake.work, sessions: [{ id: 'a', objective: 'x' }, { id: 'b', objective: 'y', model: 'glm-5.3' }] }));
  const r = plans.resolvePlan(file);
  const [a, b] = plans.sessionList(r.plan);
  assert.equal(plans.sessionInvocation(r, 'p', a).model, 'GLM-5.3-Flash');
  assert.equal(plans.sessionInvocation(r, 'p', b).model, 'GLM-5.3');
});

test('resume keeps the session model; a model-less settings file falls back to Flash', async () => {
  fake.setScript({ turns: [{ response: done() }, { response: done() }] });
  await execute(invocation(fake, { id: 'rs-1', checks: [] }));
  const { readSettings } = require('../../lib/executor.js');
  assert.equal(readSettings('rs-1').model, 'GLM-5.3-Flash');
});

test('copied agent profiles follow the session model; the live files are untouched', async () => {
  fs.mkdirSync(path.join(fake.live, 'agents'), { recursive: true });
  const pins = {
    'a.md': '---\nname: a\nmodel: "account:zai-individual-coding-plan/GLM-5.3"\n---\nbody\n',
    'b.md': '---\nname: b\nmodel: "custom:account%3Azai-individual-coding-plan:GLM-5.3"\n---\nbody\n',
    'c.md': '---\nname: c\nmodel: account:zai-individual-coding-plan/GLM-5.3-Flash\n---\nbody\n',
    'd.md': '---\nname: d\nmodel: other/model\n---\nuse GLM-5.3 here\n',
    'e.md': '# no frontmatter\nmodel: x/GLM-5.3\n',
  };
  for (const [n, t] of Object.entries(pins)) fs.writeFileSync(path.join(fake.live, 'agents', n), t);
  const { buildEngineHome } = require('../../lib/isolation.js');
  const home = path.join(fake.base, 'h');
  buildEngineHome({ home, root: fake.root, key: 'k', live: fake.live });
  const got = (n) => fs.readFileSync(path.join(home, '.zcode', 'agents', n), 'utf8');
  assert.match(got('a.md'), /model: "account:zai-individual-coding-plan\/GLM-5\.3-Flash"/, 'default session model is Flash');
  assert.match(got('b.md'), /model: "custom:account%3Azai-individual-coding-plan:GLM-5\.3-Flash"/);
  assert.equal(got('d.md'), pins['d.md']);
  assert.equal(got('e.md'), pins['e.md']);
  buildEngineHome({ home, root: fake.root, key: 'k', live: fake.live, model: 'GLM-5.3' });
  assert.match(got('a.md'), /GLM-5\.3"\n/);
  assert.match(got('c.md'), /plan\/GLM-5\.3\n/);
  for (const [n, t] of Object.entries(pins)) assert.equal(fs.readFileSync(path.join(fake.live, 'agents', n), 'utf8'), t);
});

// --- watch / idle ---------------------------------------------------------------

test('doctor: models report image support; --json has vision', () => {
  const { supportsImage, modelVision, visionModel } = require('../../lib/models.js');
  assert.deepEqual(modelVision({ builtinConfig: fake.base + '/zcode-builtin.json' }), { 'GLM-5.3': false, 'GLM-5.3-Flash': true });
  assert.equal(supportsImage('GLM-5.3'), false);
  assert.equal(visionModel({ builtinConfig: fake.base + '/zcode-builtin.json' }), 'GLM-5.3-Flash');
  const rules = path.join(fake.base, 'rules.json');
  fs.writeFileSync(rules, JSON.stringify({ config: { modelConfigRules: { modelRules: [
    { modelMatch: '.*glm-5\\.3(?:-flash)?.*', config: { properties: { inputFormat: { supportsImage: false } } } },
    { modelMatch: '.*glm-5\\.3-flash.*', config: { properties: { inputFormat: { supportsImage: true } } } },
  ] } } }));
  assert.deepEqual(modelVision({ builtinConfig: rules }), { 'GLM-5.3': false, 'GLM-5.3-Flash': true });
});

test('idleInfo: only running sessions; stalled after the threshold', () => {
  const now = Date.now();
  const view = (ago, state = 'running') => ({ state, activity: { lastEventAt: new Date(now - ago).toISOString() } });
  assert.equal(store.idleInfo(view(1000, 'finished'), { now }), null);
  assert.deepEqual(store.idleInfo(view(5000), { now }), { idleMs: 5000 });
  assert.deepEqual(store.idleInfo(view(9 * 60000), { now }), { idleMs: 9 * 60000, stalled: true });
  assert.deepEqual(store.idleInfo(view(2 * 60000), { now, stallMin: 1 }), { idleMs: 120000, stalled: true });
});

test('watch: piped output prints a changed line once; exits 0 when finished; --help is small', async () => {
  fake.setScript({ turns: [{ response: done(), tool: 'Write' }] });
  await execute(invocation(fake, { id: 'wt-1', checks: [] }));
  const r = cli(['watch', 'wt-1']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^wt-1  \S+  \S+  last: Write \S+ ago  req 1  sub 0\n$/);
  const none = cli(['watch', 'nope']);
  assert.equal(none.status, 2);
  const h = cli(['watch', '--help']);
  assert.ok(h.stdout.length <= 2000);
  assert.match(h.stdout, /usage: zcode watch/);
  assert.equal(cli(['watch', '--stall-min', 'x', 'wt-1']).status, 2);
  assert.equal(cli(['status', '--plan', 'x']).status, 2);
});

test('status --json reports idleMs for a running session and stalled past 8 minutes', () => {
  const rec = store.createSession('st-1', { kind: 'task', cwd: fake.work, model: 'GLM-5.3-Flash', effort: 'max', owns: [], checks: [] });
  store.updateSession('st-1', { state: 'running', phase: 'executing', pid: process.pid, activity: { lastEventAt: new Date(Date.now() - 9 * 60000).toISOString(), modelRequests: 3 } });
  const j = JSON.parse(cli(['status', 'st-1', '--json']).stdout);
  assert.equal(j.stalled, true);
  assert.ok(j.idleMs >= 9 * 60000);
  assert.match(cli(['status', 'st-1']).stdout, /STALLED\?/);
  assert.match(cli(['wait', 'st-1', '--timeout-ms', '300']).stdout, /^st-1 running executing \S+ idle \S+ STALLED\?\n$/);
  void rec;
});

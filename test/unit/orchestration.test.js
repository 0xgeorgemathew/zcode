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

test('unmet visual criteria trigger a repair turn; met after repair completes, with notVerified', async () => {
  const bad = [{ criterion: 'CTA visible above the fold', viewport: '390x844', met: false, note: 'below the fold', shot: 'shots/m.png' }];
  const good = [{ criterion: 'CTA visible above the fold', viewport: '390x844', met: true, note: 'ok', shot: 'shots/m2.png' }];
  fake.setScript({ turns: [{ response: done({ visual: bad }) }, { response: done({ visual: good }) }] });
  const r = await execute(invocation(fake, { id: 'v-1', contract: { visual: ['CTA visible above the fold'], checks: ['true'] } }));
  assert.equal(r.status, 'completed', JSON.stringify(r.issues));
  assert.equal(r.repairs, 1);
  assert.deepEqual(r.visual, good);
  const repair = sends()[1];
  assert.match(repair, /Visual criteria not met/);
  assert.match(repair, /CTA visible above the fold @390x844/);
  assert.match(repair, /\$ZCODE_PORT/);
  assert.ok(r.notVerified.some((n) => /executor's judgement from its own screenshots \(1 of 1 reported met\)/.test(n)));
  assert.equal(buildBrief(r).visual, undefined, 'met criteria are a count, not entries');
  assert.equal(buildBrief(r).visualMet, '1/1');
});

test('unmet visual after the repair budget is partial with a visual issue; no checks needed for the loop', async () => {
  const bad = [{ criterion: 'CTA visible above the fold', viewport: '1440x900', met: false, note: 'hidden' }];
  fake.setScript({ turns: [{ response: done({ visual: bad }) }] });
  const r = await execute(invocation(fake, {
    id: 'v-2', maxRepairs: 1, contract: { visual: ['CTA visible above the fold'] },
  }));
  assert.equal(r.status, 'partial');
  assert.equal(r.repairs, 1);
  assert.ok(r.issues.some((i) => /^visual criteria unmet: CTA visible above the fold @1440x900/.test(i)));
  assert.equal(sends().length, 2);
});

test('visual reported nowhere counts as unmet; failing checks and unmet visual share one repair prompt', async () => {
  const marker = path.join(fake.work, 'fixed');
  fake.setScript({
    turns: [
      { response: done() },
      { write: { path: 'fixed', content: '1' }, response: done({ visual: [{ criterion: 'v', viewport: '390x844', met: true }] }) },
    ],
  });
  const r = await execute(invocation(fake, { id: 'v-3', contract: { visual: ['v'], checks: ['test -f fixed'] } }));
  assert.equal(r.status, 'completed', JSON.stringify(r.issues));
  assert.equal(r.repairs, 1);
  assert.ok(fs.existsSync(marker));
  const repair = sends()[1];
  assert.match(repair, /acceptance checks and one failed/);
  assert.match(repair, /v \(not reported\)/);
  assert.equal((repair.match(/repair attempt/g) || []).length, 1);

  const text = buildRepairPrompt([{ command: 'x', output: 'boom', exitCode: 1 }], { attempt: 1, maxRepairs: 2, visual: ['v @390x844'] });
  assert.match(text, /### `x` \(exit 1\)[\s\S]*Visual criteria not met[\s\S]*- v @390x844/);
});

test('repair prompt without visual is unchanged', () => {
  const t = buildRepairPrompt([{ command: 'npm test', output: 'fail', exitCode: 1 }], { attempt: 1, maxRepairs: 2 });
  assert.match(t, /^Zcode ran the acceptance checks and one failed \(repair attempt 1 of 2\):/);
  assert.doesNotMatch(t, /isual/);
});

// --- visual report-only follow-up --------------------------------------------

const vOk = [{ criterion: 'CTA visible above the fold', viewport: '390x844', met: true }];
const vBad = [{ criterion: 'CTA visible above the fold', viewport: '390x844', met: false }];
const vContract = { visual: ['CTA visible above the fold'], checks: ['true'] };

test('missing visual: report-only follow-up completes without a repair', async () => {
  fake.setScript({ turns: [{ response: done() }, { response: done({ visual: vOk }) }] });
  const r = await execute(invocation(fake, { id: 'vr-1', contract: vContract }));
  assert.equal(r.status, 'completed', JSON.stringify(r.issues));
  assert.equal(r.repairs, 0);
  assert.equal(sends().length, 2);
  assert.match(sends()[1], /^Do not redo any work\. Reply with only the handback block, including `visual` for every criterion: CTA visible above the fold/);
});

test('visual still missing after the follow-up goes to the repair path', async () => {
  fake.setScript({ turns: [{ response: done() }, { response: done() }, { response: done({ visual: vOk }) }] });
  const r = await execute(invocation(fake, { id: 'vr-2', contract: vContract }));
  assert.equal(r.status, 'completed', JSON.stringify(r.issues));
  assert.equal(r.repairs, 1);
  assert.equal(sends().length, 3);
  assert.match(sends()[1], /^Do not redo any work/);
  assert.match(sends()[2], /Visual criteria not met/);
});

test('visual met:false goes straight to repair with no follow-up', async () => {
  fake.setScript({ turns: [{ response: done({ visual: vBad }) }, { response: done({ visual: vOk }) }] });
  const r = await execute(invocation(fake, { id: 'vr-3', contract: vContract }));
  assert.equal(r.status, 'completed', JSON.stringify(r.issues));
  assert.equal(r.repairs, 1);
  assert.equal(sends().length, 2);
  assert.match(sends()[1], /Visual criteria not met/);
});

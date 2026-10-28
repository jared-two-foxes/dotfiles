import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { git } from '../pi/agent/extensions/conductor/git-tree.mjs';
import { snapshot, readFeatureEvidence, featureEvidenceReferences } from '../pi/agent/extensions/conductor/evidence.mjs';
import { executeAndReview } from '../pi/agent/extensions/conductor/adapter.mjs';
import { checkpointVerifiedTask } from '../pi/agent/extensions/conductor/checkpoint.mjs';
import { scaffoldTasks, designReference } from '../pi/agent/extensions/scaffold/adapter.mjs';
import { validateFeature, inspectFeatureValidation } from '../pi/agent/extensions/conductor/feature.mjs';
import { reconcileFeature, inspectReconciliation, readReconciliation } from '../pi/agent/extensions/conductor/reconciliation.mjs';
import { runCheck } from '../pi/agent/extensions/conductor/feature-process.mjs';

const integration = { skip: !process.env.SCAFFOLD_SOURCE ? 'Set SCAFFOLD_SOURCE to Phase 5 Scaffold checkout' : false };
async function fixture(t, legacy = false) {
  const root = await mkdtemp(path.join(tmpdir(), 'pi-feature-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = path.join(root, 'repo');
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  const g = (...args) => git(dir, args);
  g('config', 'user.name', 'Test'); g('config', 'user.email', 'test@example.invalid');
  g('config', 'core.autocrlf', 'false');
  await writeFile(path.join(dir, '.gitignore'), '.scaffold/\noutput/\n');
  await writeFile(path.join(dir, 'source.txt'), 'base\n');
  if (legacy) await writeFile(path.join(dir, 'approved.md'), 'Original Git-approved feature design: producer and consumer must interoperate.');
  g('add', '.'); g('commit', '-qm', 'A'); g('switch', '-qc', 'feature/test');
  const base = g('rev-parse', 'HEAD');
  const invokeScaffold = async (_program, args, ctx) => {
    try {
      const stdout = execFileSync(process.env.PYTHON ?? 'python3', ['-c',
        'import sys;sys.path.insert(0, sys.argv.pop(1));from scaffold_cli.cli import main;main()',
        path.join(process.env.SCAFFOLD_SOURCE, 'src'), ...args], { cwd: ctx.cwd, input: ctx.input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
      return { code: 0, stdout, stderr: '' };
    } catch (e) { return { code: e.status, stdout: e.stdout?.toString(), stderr: e.stderr?.toString() }; }
  };
  const scaffoldOptions = { invokeScaffold };
  const call = async (operation, extra = {}) => {
    const response = await scaffoldTasks({ operation, feature_id: 'F5', ...extra }, { directory: dir }, scaffoldOptions);
    assert.equal(response.ok, true, JSON.stringify(response)); return response.data;
  };
  const context = 'Approved feature: producer and consumer must interoperate. Preserve errors.\nOriginal baseline: ' + base;
  const designRef = legacy ? 'approved.md@' + base : designReference(context);
  await call('init', { payload: { id: 'F5', title: 'Complete feature', objective: 'Integrated behavior',
    context, design_ref: designRef, acceptance_criteria: ['Producer and consumer interoperate', 'Errors handled'] } });
  const add = (id, dependencies = [], parent) => call(parent ? 'decompose' : 'add', {
    ...(parent ? { task_id: parent } : {}), payload: [{ id, title: id, objective: id,
      acceptance_criteria: ['Verified ' + id], dependencies }] });
  async function finish(id, empty = false, reconciliationRef) {
    await call('start', { task_id: id });
    const args = { task: { featureId: 'F5', taskId: id, designRef }, baseRef: g('rev-parse', 'HEAD'),
      input: '{"operations":[]}', requirements: 'Only task ' + id, buildCommand: ['build'], testCommand: ['test'] };
    const attempt = await executeAndReview(args, { directory: dir }, { invokeConductor: async json => {
      if (!empty) await writeFile(path.join(dir, id + '.txt'), id + '\n');
      const req = JSON.parse(json), boundary = JSON.parse(req.checks[1].args[1]);
      await writeFile(boundary.output, JSON.stringify(await snapshot(dir)));
      return { code: 0, stdout: JSON.stringify({ schema: 'conductor.result/v1', status: 'PASSED', phase: 'review',
        execution: { success: true }, checks: ['build', 'test'].map(name => ({ name, exit_code: 0 })), review: { status: 'APPROVED' } }) };
    } });
    assert.equal(attempt.status, 'PASSED', JSON.stringify(attempt));
    await call('complete', { task_id: id, payload: { feature_id: 'F5', task_id: id, result: 'PASSED',
      source: 'conductor', reference: attempt.evidence.reference, summary: 'Verified task' } });
    const checkpoint = await checkpointVerifiedTask({ task: args.task, evidenceRef: attempt.evidence.reference,
      reconciliationRef, featureBaseRef: base, branch: 'feature/test', defaultBranch: 'main', protectedBranches: [], authorizationMode: 'manual' },
    { directory: dir }, { scaffoldOptions, authorize: async () => true });
    assert.equal(checkpoint.ok, true, JSON.stringify(checkpoint));
    return checkpoint;
  }
  const review = path.join(root, 'review.cjs'), capture = path.join(root, 'capture.json');
  async function reviewer(status = 'APPROVED', mutation = '') {
    await writeFile(review, `const fs=require('node:fs');const args=process.argv.slice(2);
const req=JSON.parse(fs.readFileSync(args[args.indexOf('--request')+1],'utf8'));
fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify({req,requirements:fs.readFileSync(req.requirements,'utf8'),args}));
${mutation}
console.log(JSON.stringify({schema:'review.result/v1',status:${JSON.stringify(status)},reason:${JSON.stringify(status === 'INDETERMINATE' ? 'BUDGET_EXHAUSTED' : 'REVIEW_COMPLETED')},review_id:'feature-review',completed_at:'2026-10-26T00:00:00Z',findings:${status === 'CHANGES_REQUESTED' ? "[{blocking:true,severity:'high',message:'Consumer interface mismatches producer'}]" : '[]'}}));process.exit(${({ APPROVED: 0, CHANGES_REQUESTED: 1, INDETERMINATE: 3 })[status]});`);
  }
  await reviewer();
  const options = { scaffoldOptions, authorize: async () => true, reviewOptions: { executable: process.execPath, prefixArgs: [review] } };
  const args = () => ({ featureId: 'F5', designRef, featureBaseRef: base, headRef: g('rev-parse', 'HEAD'), branch: 'feature/test',
    buildCommand: [process.execPath, '-e', 'console.log("project built")'],
    testCommand: [process.execPath, '-e', 'console.log("12 integration tests passed")'], testSuccessPattern: '12 integration tests passed',
    review: { maxTurns: 8, maxToolCalls: 30, wallClockBudgetSecs: 30 } });
  const validate = (patch = {}, optionPatch = {}) => validateFeature({ ...args(), ...patch }, { directory: dir }, { ...options, ...optionPatch });
  return { dir, g, base, add, finish, call, reviewer, options, args, validate, capture };
}

test('A → B → C → D feature review, failed integration, corrective E and revalidation A → E', integration, async t => {
  const f = await fixture(t);
  await f.add('parent'); await f.add('one', [], 'parent'); await f.add('two', ['one'], 'parent');
  await f.finish('one'); await f.finish('two'); const d = await f.finish('parent', true);
  assert.equal(f.g('rev-list', '--count', f.base + '..HEAD'), '3');
  await f.reviewer('CHANGES_REQUESTED');
  const failed = await f.validate(); assert.equal(failed.status, 'NEEDS_DESIGN', JSON.stringify(failed));
  assert.equal((await f.call('list')).feature.validation.status, 'failed');
  let capture = JSON.parse(await readFile(f.capture, 'utf8'));
  assert.equal(capture.req.base_ref, f.base); assert.equal(capture.req.head_ref, d.commit);
  assert.match(capture.requirements, /Approved feature: producer and consumer/);
  assert.match(capture.requirements, /Producer and consumer interoperate/);
  assert.match(capture.requirements, /12 integration tests passed/);
  assert.match(capture.requirements, /cross-task integration/);
  assert.equal(capture.args[capture.args.indexOf('--max-tool-calls') + 1], '30');
  await f.add('fix', ['parent']);
  assert.equal((await f.validate()).status, 'BLOCKED');
  const e = await f.finish('fix'); await f.reviewer();
  const passed = await f.validate(); assert.equal(passed.status, 'PASSED', JSON.stringify(passed));
  assert.equal(passed.binding.head, e.commit); assert.equal(passed.binding.baseline, f.base);
  capture = JSON.parse(await readFile(f.capture, 'utf8')); assert.equal(capture.req.head_ref, e.commit);
  const feature = (await f.call('list')).feature;
  assert.equal(feature.validation.status, 'verified');
  assert.deepEqual(feature.validation.history.filter(h => h.event === 'finished').map(h => h.result.status), ['NEEDS_DESIGN', 'PASSED']);
  const retry = await f.validate({ resumeEvidenceRef: passed.evidenceRef });
  assert.equal(retry.status, 'PASSED', JSON.stringify(retry)); assert.equal(retry.recovered, true);
  assert.deepEqual((await f.call('list')).feature.validation.history, feature.validation.history);
});

test('unfinished, blocked, missing-checkpoint, unrelated-commit and changed-design features fail closed', integration, async t => {
  for (const variant of ['pending', 'blocked', 'missingCheckpoint', 'unrelated', 'design']) {
    const f = await fixture(t); await f.add('one');
    if (variant === 'blocked') await f.call('block', { task_id: 'one', reason: 'Needs architecture' });
    if (['unrelated', 'missingCheckpoint', 'design'].includes(variant)) await f.finish('one');
    if (variant === 'unrelated') f.g('commit', '--allow-empty', '-qm', 'Unrelated commit');
    if (variant === 'missingCheckpoint') f.g('reset', '--hard', f.base);
    const r = await f.validate(variant === 'design' ? { designRef: 'wrong' } : {});
    assert.equal(r.status, 'BLOCKED', variant + JSON.stringify(r));
    assert.equal((await featureEvidenceReferences(f.dir)).length, 0);
  }
});

test('lost or modified task evidence prevents feature validation', integration, async t => {
  for (const variant of ['lost', 'modified']) {
    const f = await fixture(t); await f.add('one'); const c = await f.finish('one');
    const file = path.join(f.dir, '.git/pi-conductor-evidence', c.evidenceRef.split(':').at(-1) + '.json');
    if (variant === 'lost') await rm(file); else await writeFile(file, '{}');
    assert.equal((await f.validate()).status, 'BLOCKED');
  }
});

test('full checks: nonzero, missing tool, absent meaningful tests, integration failure and indeterminate review', integration, async t => {
  const f = await fixture(t); await f.add('one'); await f.finish('one');
  for (const [patch, expected] of [
    [{ testCommand: [process.execPath, '-e', 'console.error("integration defect");process.exit(7)'] }, 'NEEDS_DESIGN'],
    [{ buildCommand: ['definitely-missing-verification-program'] }, 'BLOCKED'],
    [{ testCommand: [process.execPath, '-e', 'console.log("0 tests ran")'] }, 'BLOCKED'],
    [{ integrationChecks: [{ name: 'smoke', command: [process.execPath, '-e', 'process.exit(5)'], successPattern: 'smoke passed' }] }, 'NEEDS_DESIGN'],
  ]) {
    const r = await f.validate(patch); assert.equal(r.status, expected, JSON.stringify(r));
    assert.notEqual((await f.call('list')).feature.validation.status, 'verified');
    assert.ok(r.evidenceRef);
  }
  await f.reviewer('INDETERMINATE'); assert.equal((await f.validate()).status, 'BLOCKED');
});

test('source mutations during checks/review, branch changes and stale successful evidence cannot complete', integration, async t => {
  for (const variant of ['check', 'review', 'head', 'staged', 'branch']) {
    const f = await fixture(t); await f.add('one'); await f.finish('one');
    if (variant === 'check') {
      const r = await f.validate({ testCommand: [process.execPath, '-e', 'require("fs").writeFileSync("source.txt","changed");console.log("12 integration tests passed")'] });
      assert.equal(r.status, 'BLOCKED'); assert.match(r.message, /clean|changed/);
    } else if (variant === 'review') {
      await f.reviewer('APPROVED', 'fs.writeFileSync(require("node:path").join(req.repository_path,"source.txt"),"changed");');
      assert.equal((await f.validate()).status, 'BLOCKED');
    } else {
      const r = await f.validate(); assert.equal(r.status, 'PASSED', JSON.stringify(r));
      if (variant === 'head') f.g('commit', '--allow-empty', '-qm', 'changed HEAD');
      if (variant === 'staged') { await writeFile(path.join(f.dir, 'source.txt'), 'changed'); f.g('add', '.'); }
      if (variant === 'branch') f.g('switch', '-qc', 'other-feature');
      assert.equal((await f.validate({ resumeEvidenceRef: r.evidenceRef })).status, 'BLOCKED');
      const inspected = await inspectFeatureValidation({ reference: r.evidenceRef }, { directory: f.dir }, f.options);
      assert.equal(inspected.ok, true); assert.equal(inspected.results[0].applicable, false);
      assert.equal((await readFeatureEvidence(f.dir, r.evidenceRef)).result.status, 'PASSED');
    }
  }
});

test('interruption before/during verification never infers success; retained complete results reconcile once', integration, async t => {
  for (const point of ['beforeChecks', 'beforeReview', 'beforeRetention', 'afterRetention', 'afterCompletion']) {
    const f = await fixture(t); await f.add('one'); await f.finish('one');
    const interrupted = await f.validate({}, { interrupt: async stage => { if (stage === point) throw Error('Interrupted at ' + point); } });
    assert.equal(interrupted.status, 'BLOCKED');
    if (['afterRetention', 'afterCompletion'].includes(point)) {
      const recovered = await f.validate({ resumeEvidenceRef: interrupted.evidenceRef });
      assert.equal(recovered.status, 'PASSED', JSON.stringify(recovered));
      const before = (await f.call('list')).feature.validation.history;
      assert.equal((await f.validate({ resumeEvidenceRef: interrupted.evidenceRef })).status, 'PASSED');
      assert.deepEqual((await f.call('list')).feature.validation.history, before);
    } else {
      assert.notEqual((await f.call('list')).feature.validation.status, 'verified');
      assert.equal((await f.validate({ resumeEvidenceRef: interrupted.startedReference })).status, 'BLOCKED');
      assert.equal((await f.validate()).status, 'PASSED');
    }
  }
});

test('no UI authority, task changes during checks and tampered feature evidence fail closed', integration, async t => {
  const f = await fixture(t); await f.add('one'); await f.finish('one');
  assert.equal((await f.validate({}, { authorize: undefined })).status, 'BLOCKED');
  assert.equal((await f.validate({}, { authorize: async () => false })).status, 'BLOCKED');
  const passed = await f.validate(); assert.equal(passed.status, 'PASSED');
  await writeFile(path.join(f.dir, '.git/pi-conductor-evidence/feature-' + passed.evidenceRef.split(':').at(-1) + '.json'), '{}');
  assert.equal((await f.validate({ resumeEvidenceRef: passed.evidenceRef })).status, 'BLOCKED');
  const r = await f.validate({}, { interrupt: async stage => { if (stage === 'beforeReview') await f.add('correction', ['one']); } });
  assert.equal(r.status, 'BLOCKED');
});

test('verification subprocess bounds, cancellation and diagnostics preserve actual exit codes', async () => {
  const run = (code, options = {}) => runCheck([process.execPath, '-e', code], options);
  assert.equal((await run('console.error("failure detail");process.exit(9)')).exit_code, 9);
  assert.equal((await run('console.log("ok")')).stdout.trim(), 'ok');
  assert.equal((await run('setInterval(()=>{},1000)', { timeoutMs: 50 })).problem, 'TIMEOUT');
  assert.equal((await run('process.stdout.write("x".repeat(100000));setInterval(()=>{},1000)')).problem, 'OUTPUT_LIMIT');
  const controller = new AbortController(); setTimeout(() => controller.abort(), 50);
  assert.equal((await run('setInterval(()=>{},1000)', { signal: controller.signal })).problem, 'CANCELLED');
  assert.equal((await runCheck(['missing-check-program'])).problem, 'ENOENT');
});


test('restored tracked edits fail, ignored generated outputs pass, and invalid review plans run no commands', integration, async t => {
  const f = await fixture(t); await f.add('one'); await f.finish('one');
  const restored = await f.validate({ testCommand: [process.execPath, '-e',
    'const fs=require("fs");const original=fs.readFileSync("source.txt");fs.writeFileSync("source.txt","transient");fs.writeFileSync("source.txt",original);console.log("12 integration tests passed")'] });
  assert.equal(restored.status, 'BLOCKED', JSON.stringify(restored));
  const generated = await f.validate({ testCommand: [process.execPath, '-e',
    'const fs=require("fs");fs.mkdirSync("output",{recursive:true});fs.writeFileSync("output/report.txt","generated");console.log("12 integration tests passed")'] });
  assert.equal(generated.status, 'PASSED', JSON.stringify(generated));
  const invalid = await f.validate({ review: { maxTurns: 0 }, buildCommand: [process.execPath, '-e', 'require("fs").writeFileSync("source.txt","must not run")'] });
  assert.equal(invalid.status, 'BLOCKED'); assert.equal(f.g('status', '--porcelain'), '');
});

test('interrupted check/review and failed completion retention remain recoverable diagnostics', integration, async t => {
  const f = await fixture(t); await f.add('one'); await f.finish('one');
  const timeout = await f.validate({ testCommand: [process.execPath, '-e', 'setInterval(()=>{},1000)'], checkTimeoutMs: 100 });
  assert.equal(timeout.status, 'BLOCKED');
  const receipt = await readFeatureEvidence(f.dir, timeout.evidenceRef);
  assert.ok(receipt.checks.some(c => c.problem === 'TIMEOUT'));
  await f.reviewer('APPROVED', 'while(true) {}');
  const blocked = await f.validate({}, { reviewOptions: { ...f.options.reviewOptions, timeoutMs: 100 } });
  assert.equal(blocked.status, 'BLOCKED');
  await f.reviewer();
  const invokeScaffold = f.options.scaffoldOptions.invokeScaffold;
  const failedHandoff = await f.validate({}, { scaffoldOptions: { invokeScaffold: async (program, args, ctx) =>
    args[1] === 'validation-record' ? { code: 1, stderr: 'simulated handoff outage' } : invokeScaffold(program, args, ctx) } });
  assert.equal(failedHandoff.status, 'BLOCKED');
  assert.equal((await readFeatureEvidence(f.dir, failedHandoff.evidenceRef)).result.status, 'PASSED');
  assert.equal((await f.validate({ resumeEvidenceRef: failedHandoff.evidenceRef })).status, 'PASSED');
});


test('legacy immutable Git design references review original text', integration, async t => {
  const f = await fixture(t, true); await f.add('one'); await f.finish('one');
  const r = await f.validate(); assert.equal(r.status, 'PASSED', JSON.stringify(r));
  const capture = JSON.parse(await readFile(f.capture, 'utf8'));
  assert.match(capture.requirements, /Original Git-approved feature design/);
});

// Real Git rebases + real Scaffold, with deterministic external verification fixtures.
async function rebaseFixture(t, task = true) {
  const f = await fixture(t);
  if (task) { await f.add('one'); await f.finish('one'); }
  const rebase = async (previousReconciliationRef) => {
    const oldHeadRef = f.g('rev-parse', 'HEAD');
    f.g('switch', 'main');
    await writeFile(path.join(f.dir, 'upstream-' + f.g('rev-list', '--count', 'HEAD') + '.txt'), 'upstream change\n');
    f.g('add', '.'); f.g('commit', '-qm', 'Upstream change');
    const upstreamBaseRef = f.g('rev-parse', 'HEAD');
    f.g('switch', 'feature/test'); f.g('rebase', 'main');
    return { ...f.args(), oldHeadRef, upstreamBaseRef, defaultBranch: 'main', protectedBranches: [], previousReconciliationRef };
  };
  const reconcile = (args, patch = {}, optionPatch = {}) => reconcileFeature({ ...args, ...patch }, { directory: f.dir }, { ...f.options, ...optionPatch });
  return { ...f, rebase, reconcile };
}

test('rebase recovery preserves receipts, continues a dependent task and passes final feature validation', integration, async t => {
  const f = await rebaseFixture(t);
  const args = await f.rebase();
  const originalMessage = f.g('show', '-s', '--format=%B', args.oldHeadRef);
  const originalReceipt = JSON.parse(originalMessage.split('Pi-Task-Checkpoint: ')[1]).evidenceRef;
  const receiptPath = path.join(f.dir, '.git/pi-conductor-evidence', originalReceipt.split(':').at(-1) + '.json');
  const bytes = await readFile(receiptPath);
  assert.equal((await f.validate()).status, 'BLOCKED');
  const r = await f.reconcile(args); assert.equal(r.status, 'PASSED', JSON.stringify(r));
  assert.equal(f.g('rev-parse', 'HEAD'), args.headRef);
  assert.deepEqual(await readFile(receiptPath), bytes);
  const capture = JSON.parse(await readFile(f.capture, 'utf8'));
  assert.equal(capture.req.base_ref, args.upstreamBaseRef);
  assert.match(capture.requirements, /Only task one/);
  assert.match(capture.requirements, /conflict resolutions/);
  const inspected = await inspectReconciliation({ reference: r.evidenceRef }, { directory: f.dir }, f.options);
  assert.equal(inspected.results[0].applicable, true, JSON.stringify(inspected));
  await f.add('two', ['one']); await f.finish('two', false, r.evidenceRef);
  const passed = await f.validate({ reconciliationRef: r.evidenceRef });
  assert.equal(passed.status, 'PASSED', JSON.stringify(passed));
  assert.equal(passed.binding.baseline, f.base); // Scaffold's immutable original baseline is preserved.
  assert.equal((await f.validate({ reconciliationRef: r.evidenceRef, resumeEvidenceRef: passed.evidenceRef })).status, 'PASSED');
  const validation = await inspectFeatureValidation({ reference: passed.evidenceRef }, { directory: f.dir }, f.options);
  assert.equal(validation.results[0].applicable, true, JSON.stringify(validation));
  assert.equal((await f.validate({ resumeEvidenceRef: passed.evidenceRef })).status, 'BLOCKED');
});

test('repeated rebases authenticate prior anchors and retain final applicability', integration, async t => {
  const f = await rebaseFixture(t);
  const firstArgs = await f.rebase();
  const first = await f.reconcile(firstArgs); assert.equal(first.status, 'PASSED', JSON.stringify(first));
  await f.add('two', ['one']); await f.finish('two', false, first.evidenceRef);
  const secondArgs = await f.rebase(first.evidenceRef);
  const second = await f.reconcile(secondArgs); assert.equal(second.status, 'PASSED', JSON.stringify(second));
  assert.equal((await f.validate({ reconciliationRef: second.evidenceRef })).status, 'PASSED');
  assert.equal((await f.validate({ reconciliationRef: first.evidenceRef })).status, 'BLOCKED');
  const inspection = await inspectReconciliation({ featureId: 'F5' }, { directory: f.dir }, f.options);
  assert.equal(inspection.results.find(r => r.reference === first.evidenceRef).applicable, false);
  assert.equal(inspection.results.find(r => r.reference === second.evidenceRef).applicable, true);
});

test('rebase before first task supports new initial anchor without changing original design', integration, async t => {
  const f = await rebaseFixture(t, false); await f.add('one');
  const args = await f.rebase(); const r = await f.reconcile(args);
  assert.equal(r.status, 'PASSED', JSON.stringify(r));
  await f.finish('one', false, r.evidenceRef);
  assert.equal((await f.validate({ reconciliationRef: r.evidenceRef })).status, 'PASSED');
});

test('rebase verification failures and missing authorization cannot supply an anchor', integration, async t => {
  const f = await rebaseFixture(t); const args = await f.rebase();
  for (const [patch, options, expected] of [
    [{}, { authorize: undefined }, 'BLOCKED'],
    [{}, { authorize: async () => false }, 'BLOCKED'],
    [{ testCommand: [process.execPath, '-e', 'console.log("0 tests ran")'] }, {}, 'BLOCKED'],
    [{ testCommand: [process.execPath, '-e', 'process.exit(7)'] }, {}, 'NEEDS_DESIGN'],
    [{ buildCommand: ['missing-rebase-build-command'] }, {}, 'BLOCKED'],
  ]) {
    const r = await f.reconcile(args, patch, options);
    assert.equal(r.status, expected, JSON.stringify(r));
    if (r.evidenceRef) assert.equal((await f.validate({ reconciliationRef: r.evidenceRef })).status, 'BLOCKED');
  }
  await f.reviewer('CHANGES_REQUESTED'); assert.equal((await f.reconcile(args)).status, 'NEEDS_DESIGN');
  await f.reviewer('INDETERMINATE'); assert.equal((await f.reconcile(args)).status, 'BLOCKED');
});

test('active tasks, dirty trees, unrelated commits, protected branches and unfinished rebase block before checks', integration, async t => {
  for (const variant of ['active', 'dirty', 'unrelated', 'protected', 'rebase']) {
    const f = await rebaseFixture(t); await f.add('two', ['one']);
    const args = await f.rebase();
    if (variant === 'active') await f.call('start', { task_id: 'two' });
    if (variant === 'dirty') await writeFile(path.join(f.dir, 'source.txt'), 'unverified');
    if (variant === 'unrelated') { f.g('commit', '--allow-empty', '-qm', 'unrelated'); args.headRef = f.g('rev-parse', 'HEAD'); }
    if (variant === 'protected') args.protectedBranches = ['feature/test'];
    if (variant === 'rebase') await (await import('node:fs/promises')).mkdir(path.join(f.dir, '.git/rebase-merge'));
    const r = await f.reconcile(args, {}, { authorize: () => { throw Error('must not request authorization'); } });
    assert.equal(r.status, 'BLOCKED', variant + JSON.stringify(r));
    assert.doesNotMatch(r.message, /must not request authorization/);
    assert.equal(r.startedReference, undefined);
  }
});

test('interrupted rebase verification recovers retained success, never partial intents', integration, async t => {
  for (const point of ['beforeChecks', 'beforeReview', 'beforeRetention', 'afterRetention']) {
    const f = await rebaseFixture(t); const args = await f.rebase();
    const r = await f.reconcile(args, {}, { interrupt: async stage => { if (stage === point) throw Error('interrupted'); } });
    assert.equal(r.status, 'BLOCKED');
    const resume = await f.reconcile(args, { resumeEvidenceRef: r.evidenceRef ?? r.startedReference });
    assert.equal(resume.status, point === 'afterRetention' ? 'PASSED' : 'BLOCKED', JSON.stringify(resume));
    if (point === 'afterRetention') {
      assert.equal(resume.recovered, true);
      assert.equal((await f.reconcile(args, { resumeEvidenceRef: r.evidenceRef, testSuccessPattern: 'different output' })).status, 'BLOCKED');
    }
  }
});

test('changed source/task state during rebase verification and tampered receipts fail closed', integration, async t => {
  for (const variant of ['check', 'review', 'restored', 'state', 'tampered', 'lostSource', 'stale']) {
    const f = await rebaseFixture(t); const args = await f.rebase();
    if (variant === 'check' || variant === 'restored') {
      const command = variant === 'check' ? 'fs.writeFileSync("source.txt","changed");' :
        'const b=fs.readFileSync("source.txt");fs.writeFileSync("source.txt","transient");fs.writeFileSync("source.txt",b);';
      const r = await f.reconcile(args, { testCommand: [process.execPath, '-e', 'const fs=require("fs");' + command + 'console.log("12 integration tests passed")'] });
      assert.equal(r.status, 'BLOCKED', JSON.stringify(r));
    } else if (variant === 'review') {
      await f.reviewer('APPROVED', 'fs.writeFileSync(require("node:path").join(req.repository_path,"source.txt"),"changed");');
      assert.equal((await f.reconcile(args)).status, 'BLOCKED');
    } else if (variant === 'state') {
      assert.equal((await f.reconcile(args, {}, { interrupt: async stage => { if (stage === 'beforeReview') await f.add('new'); } })).status, 'BLOCKED');
    } else {
      const r = await f.reconcile(args); assert.equal(r.status, 'PASSED', JSON.stringify(r));
      if (variant === 'tampered') await writeFile(path.join(f.dir, '.git/pi-conductor-evidence/feature-' + r.evidenceRef.split(':').at(-1) + '.json'), '{}');
      if (variant === 'lostSource') {
        const anchor = await readFeatureEvidence(f.dir, r.evidenceRef);
        await rm(path.join(f.dir, '.git/pi-conductor-evidence', anchor.sourceCheckpoints[0].evidenceRef.split(':').at(-1) + '.json'));
      }
      if (variant === 'stale') f.g('commit', '--allow-empty', '-qm', 'unrelated');
      assert.equal((await f.validate({ reconciliationRef: r.evidenceRef })).status, 'BLOCKED');
      const inspected = await inspectReconciliation({ reference: r.evidenceRef }, { directory: f.dir }, f.options);
      if (variant !== 'tampered') assert.equal(inspected.results[0].applicable, false);
      else assert.equal(inspected.ok, false);
    }
  }
});

test('conflict resolutions are freshly reviewed and original history survives Git garbage collection', integration, async t => {
  const f = await rebaseFixture(t);
  const oldHeadRef = f.g('rev-parse', 'HEAD');
  f.g('switch', 'main');
  await writeFile(path.join(f.dir, 'one.txt'), 'upstream implementation\n');
  f.g('add', '.'); f.g('commit', '-qm', 'Upstream conflicts with task');
  const upstreamBaseRef = f.g('rev-parse', 'HEAD');
  f.g('switch', 'feature/test');
  assert.throws(() => f.g('rebase', 'main'));
  const unresolved = { ...f.args(), oldHeadRef, upstreamBaseRef, defaultBranch: 'main', protectedBranches: [] };
  assert.equal((await f.reconcile(unresolved)).status, 'BLOCKED');
  await writeFile(path.join(f.dir, 'one.txt'), 'task one integrated with upstream\n'); f.g('add', 'one.txt');
  f.g('-c', 'core.editor=true', 'rebase', '--continue');
  const args = { ...unresolved, headRef: f.g('rev-parse', 'HEAD') };
  const r = await f.reconcile(args); assert.equal(r.status, 'PASSED', JSON.stringify(r));
  const capture = JSON.parse(await readFile(f.capture, 'utf8'));
  assert.equal(capture.req.base_ref, upstreamBaseRef); assert.equal(capture.req.head_ref, args.headRef);
  assert.equal(f.g('show', args.headRef + ':one.txt'), 'task one integrated with upstream');
  f.g('reflog', 'expire', '--expire=now', '--all'); f.g('gc', '--prune=now');
  assert.equal(f.g('rev-parse', 'refs/pi-reconciliations/' + r.evidenceRef.split(':').at(-1) + '/before'), oldHeadRef);
  assert.equal((await f.validate({ reconciliationRef: r.evidenceRef })).status, 'PASSED');
});

test('dropped and reordered rebased task commits cannot be accepted', integration, async t => {
  for (const variant of ['dropped', 'reordered']) {
    const f = await rebaseFixture(t);
    const one = f.g('rev-parse', 'HEAD');
    await f.add('two', ['one']); await f.finish('two');
    const two = f.g('rev-parse', 'HEAD');
    const args = await f.rebase();
    // Mutations are confined to this disposable Git test fixture.
    f.g('reset', '--hard', args.upstreamBaseRef);
    if (variant === 'reordered') { f.g('cherry-pick', two); f.g('cherry-pick', one); }
    const r = await f.reconcile({ ...args, headRef: f.g('rev-parse', 'HEAD') }, {}, {
      authorize: () => { throw Error('must not request authorization'); },
    });
    assert.equal(r.status, 'BLOCKED'); assert.doesNotMatch(r.message, /must not request authorization/);
    assert.match(r.message, /dropped|ordering/);
  }
});

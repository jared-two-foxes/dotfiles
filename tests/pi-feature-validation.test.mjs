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
import { recoverInterruptedTaskRebase, inspectTaskRebaseRecovery } from '../pi/agent/extensions/conductor/interrupted-rebase.mjs';
import { readEvidence } from '../pi/agent/extensions/conductor/evidence.mjs';
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

test('reconciled children retain recursive ancestry when checkpointing their parents', integration, async t => {
  const f = await rebaseFixture(t, false);
  await f.add('root'); await f.add('group', [], 'root');
  await f.add('one', [], 'group'); await f.add('two', ['one'], 'group');
  await f.finish('one');
  const args = await f.rebase();
  const reconciled = await f.reconcile(args);
  assert.equal(reconciled.status, 'PASSED', JSON.stringify(reconciled));
  // Exercise both the reconciled prefix and a child checkpoint added after it.
  await f.finish('two', false, reconciled.evidenceRef);
  await f.finish('group', true, reconciled.evidenceRef);
  const root = await f.finish('root', true, reconciled.evidenceRef);
  const feature = (await f.call('list')).feature;
  assert.equal(feature.tasks.one.parent_id, 'group');
  assert.equal(feature.tasks.two.parent_id, 'group');
  assert.equal(feature.tasks.group.parent_id, 'root');
  assert.ok(Object.values(feature.tasks).every(task => task.status === 'completed'));
  const passed = await f.validate({ reconciliationRef: reconciled.evidenceRef });
  assert.equal(passed.status, 'PASSED', JSON.stringify(passed));
  assert.equal(passed.binding.head, root.commit);
});

async function interruptedFixture(t, attempts = 3) {
  const f = await rebaseFixture(t);
  await f.add('two', ['one']); await f.call('start', { task_id: 'two' });
  const task = { featureId: 'F5', taskId: 'two', designRef: f.args().designRef };
  const taskArgs = { task, baseRef: f.g('rev-parse', 'HEAD'), requirements: 'Task two preserves CRLF matching; display/context must have no terminators',
    input: '{"operations":[]}', buildCommand: ['build'], testCommand: ['test'] };
  const receipts = [];
  async function attempt(args, status = 'NEEDS_DESIGN', change = async () => {}) {
    return executeAndReview(args, { directory: f.dir }, { invokeConductor: async json => {
      await change();
      const request = JSON.parse(json);
      const boundary = JSON.parse(request.checks.at(-1).args[1]);
      await writeFile(boundary.output, JSON.stringify(await snapshot(f.dir)));
      return { code: status === 'PASSED' ? 0 : 2, stdout: JSON.stringify({ schema: 'conductor.result/v1', status, phase: 'review',
        execution: { success: true }, checks: ['build', 'test'].map(name => ({ name, exit_code: 0 })),
        review: { status: status === 'PASSED' ? 'APPROVED' : 'CHANGES_REQUESTED', findings: status === 'PASSED' ? [] : [{ message: 'Preserve carriage returns; add CRLF search regressions' }] } }) };
    } });
  }
  for (let index = 0; index < attempts; index++) {
    const r = await attempt({ ...taskArgs, previousAttempt: receipts.at(-1) }, 'NEEDS_DESIGN', async () => {
      for (let file = 0; file < 5; file++) await writeFile(path.join(f.dir, file === 0 ? 'source.txt' : 'task-two-' + file + '.txt'), 'attempt ' + (index + 1) + '\r\n');
    });
    assert.equal(r.evidence.attempt, index + 1); receipts.push(r.evidence.reference);
  }
  await f.call('block', { task_id: 'two', reason: 'Rebase interrupted this correction loop' });
  // Only this disposable fixture stashes to simulate the user's completed rebase.
  f.g('stash', 'push', '-u', '-m', 'fixture interrupted work');
  const prefixArgs = await f.rebase(); f.g('stash', 'pop');
  const args = { ...prefixArgs, task, previousAttempt: receipts.at(-1),
    testCommand: [process.execPath, '-e', 'if(require("fs").existsSync("task-two-1.txt")||require("fs").readFileSync("source.txt","utf8")!=="base\\n")throw Error("prefix checks saw unfinished task files");console.log("12 integration tests passed")'] };
  const recover = (patch = {}, options = {}) => recoverInterruptedTaskRebase({ ...args, ...patch }, { directory: f.dir }, { ...f.options, ...options });
  return { ...f, task, taskArgs, receipts, args, attempt, recover };
}

test('interrupted rebase preserves five dirty files and three receipts, resumes attempt four and completes feature', integration, async t => {
  const f = await interruptedFixture(t);
  const before = await snapshot(f.dir), index = await readFile(path.join(f.dir, '.git/index'));
  const originals = await Promise.all(f.receipts.map(ref => readFile(path.join(f.dir, '.git/pi-conductor-evidence', ref.split(':').at(-1) + '.json'))));
  const r = await f.recover(); assert.equal(r.status, 'READY', JSON.stringify(r));
  assert.equal(r.consumedAttempts, 3); assert.equal(r.remainingAttempts, 2);
  assert.deepEqual(await snapshot(f.dir), before); assert.deepEqual(await readFile(path.join(f.dir, '.git/index')), index);
  assert.equal(r.resume.input, undefined); assert.equal(r.resume.previousAttempt, r.handoffRef); assert.equal(r.resume.baseRef, f.args.headRef);
  assert.match(r.resume.requirements, /preserves CRLF/); assert.match(r.resume.requirements, /Preserve carriage returns/);
  for (let i = 0; i < f.receipts.length; i++) assert.deepEqual(await readFile(path.join(f.dir, '.git/pi-conductor-evidence', f.receipts[i].split(':').at(-1) + '.json')), originals[i]);
  assert.equal((await f.call('list')).feature.tasks.two.status, 'blocked');
  const inspected = await inspectTaskRebaseRecovery({ reference: r.handoffRef }, { directory: f.dir }, f.options);
  assert.equal(inspected.applicable, true, JSON.stringify(inspected));
  assert.equal((await f.recover({ resumeHandoffRef: r.handoffRef })).recovered, true);
  await f.call('retry', { task_id: 'two', reason: 'Authenticated rebase handoff; preserve three consumed attempts' });
  await f.call('start', { task_id: 'two' });
  const passed = await f.attempt({ ...r.resume, input: '{"operations":[]}' }, 'PASSED', async () => {
    await writeFile(path.join(f.dir, 'source.txt'), 'CRLF regression corrected\r\n');
  });
  assert.equal(passed.status, 'PASSED', JSON.stringify(passed)); assert.equal(passed.evidence.attempt, 4);
  await f.call('complete', { task_id: 'two', payload: { feature_id: 'F5', task_id: 'two', result: 'PASSED', source: 'conductor',
    reference: passed.evidence.reference, summary: 'CRLF regression verified at attempt four' } });
  const checkpoint = await checkpointVerifiedTask({ task: f.task, evidenceRef: passed.evidence.reference, reconciliationRef: r.reconciliationRef,
    featureBaseRef: f.base, branch: 'feature/test', defaultBranch: 'main', protectedBranches: [], authorizationMode: 'manual' },
  { directory: f.dir }, f.options);
  assert.equal(checkpoint.ok, true, JSON.stringify(checkpoint));
  assert.equal((await f.validate({ reconciliationRef: r.reconciliationRef })).status, 'PASSED');
});

test('interrupted recovery cannot reset attempts or weaken carried requirements/checks', integration, async t => {
  const f = await interruptedFixture(t); const r = await f.recover(); assert.equal(r.status, 'READY', JSON.stringify(r));
  for (const patch of [{ requirements: f.taskArgs.requirements }, { testCommand: ['weaker'] }, { baseRef: f.taskArgs.baseRef }]) {
    const invalid = await executeAndReview({ ...r.resume, ...patch, input: '{"operations":[]}' }, { directory: f.dir }, {
      invokeConductor: () => assert.fail('must not invoke altered recovery'),
    });
    assert.equal(invalid.status, 'BLOCKED');
  }
  const fourth = await f.attempt({ ...r.resume, input: '{"operations":[]}' }); assert.equal(fourth.evidence.attempt, 4);
  const stale = await executeAndReview({ ...r.resume, input: '{"operations":[]}' }, { directory: f.dir }, {
    invokeConductor: () => assert.fail('same-tree attempt four already consumed; do not replay the handoff'),
  });
  assert.equal(stale.status, 'BLOCKED'); assert.match(stale.message, /newer task attempt/);
  assert.equal((await f.recover({ resumeHandoffRef: r.handoffRef })).status, 'BLOCKED');
  const fifth = await f.attempt({ ...r.resume, input: '{"operations":[]}', previousAttempt: fourth.evidence.reference }); assert.equal(fifth.evidence.attempt, 5);
  const exhausted = await executeAndReview({ ...r.resume, input: '{"operations":[]}', previousAttempt: fifth.evidence.reference }, { directory: f.dir }, {
    invokeConductor: () => assert.fail('attempt six must not run'),
  });
  assert.equal(exhausted.status, 'BLOCKED'); assert.match(exhausted.message, /Five-attempt limit/);
});

test('interrupted recovery rejects unrelated source, divergent index, missing receipts and exhausted attempts', integration, async t => {
  for (const variant of ['source', 'index', 'missing', 'exhausted', 'protected', 'unapproved', 'conflict']) {
    const f = await interruptedFixture(t, variant === 'exhausted' ? 5 : 3);
    if (variant === 'source') await writeFile(path.join(f.dir, 'source.txt'), 'unrelated local edit');
    if (variant === 'index') {
      await writeFile(path.join(f.dir, 'source.txt'), 'divergent staged variant'); f.g('add', 'source.txt');
      await writeFile(path.join(f.dir, 'source.txt'), 'attempt 3\r\n');
    }
    if (variant === 'missing') await rm(path.join(f.dir, '.git/pi-conductor-evidence', f.receipts[0].split(':').at(-1) + '.json'));
    if (variant === 'conflict') {
      // A rebased commit independently changes the same task path. Never guess a resolution.
      const message = f.g('show', '-s', '--format=%B', 'HEAD');
      f.g('stash', 'push', '-u'); await writeFile(path.join(f.dir, 'source.txt'), 'conflicting upstream content');
      f.g('add', '.'); f.g('commit', '--amend', '-m', message);
      assert.throws(() => f.g('stash', 'pop'));
      await writeFile(path.join(f.dir, 'source.txt'), 'attempt 3\r\n'); f.g('add', 'source.txt');
      f.args.headRef = f.g('rev-parse', 'HEAD');
    }
    const before = await snapshot(f.dir), index = await readFile(path.join(f.dir, '.git/index'));
    const r = await f.recover(variant === 'protected' ? { protectedBranches: ['feature/test'] } : {},
      variant === 'unapproved' ? { authorize: async () => false } : {});
    assert.equal(r.status, 'BLOCKED', variant + JSON.stringify(r)); assert.equal(r.handoffRef, undefined);
    assert.deepEqual(await snapshot(f.dir), before); assert.deepEqual(await readFile(path.join(f.dir, '.git/index')), index);
  }
});

test('interrupted recovery reuses only complete matching prefix evidence and recovers retained handoff audit refs', integration, async t => {
  for (const point of ['afterPrefix', 'beforeAuditRefs', 'afterHandoffRetention']) {
    const f = await interruptedFixture(t);
    const r = await f.recover({}, { interrupt: async stage => { if (stage === point) throw Error('Interrupted at ' + point); } });
    assert.equal(r.status, 'BLOCKED');
    const recovered = point === 'afterPrefix'
      ? await f.recover({ prefixEvidenceRef: r.reconciliationRef }, { authorize: () => assert.fail('retained prefix needs no new checks') })
      : await f.recover({ resumeHandoffRef: r.handoffRef }, { authorize: () => assert.fail('retained handoff needs no new checks') });
    assert.equal(recovered.status, 'READY', JSON.stringify(recovered)); assert.equal(recovered.consumedAttempts, 3);
    const h = await readEvidence(f.dir, recovered.handoffRef);
    assert.equal(h.kind, 'rebase-handoff');
    assert.equal(f.g('for-each-ref', '--format=%(refname)', 'refs/pi-task-recoveries/' + recovered.handoffRef.split(':').at(-1)).split('\n').length, 8);
    assert.equal((await f.recover({ resumeHandoffRef: recovered.handoffRef, testSuccessPattern: 'weaker output' })).status, 'BLOCKED');
    f.g('reflog', 'expire', '--expire=now', '--all'); f.g('gc', '--prune=now');
    const inspected = await inspectTaskRebaseRecovery({ reference: recovered.handoffRef }, { directory: f.dir }, f.options);
    assert.equal(inspected.applicable, true, JSON.stringify(inspected));
  }
});

test('failed prefix checks, source/state mutation and tampered handoffs never authorize interrupted continuation', integration, async t => {
  for (const variant of ['checks', 'review', 'prefixMutation', 'sourceMutation', 'stateMutation', 'tampered', 'stale']) {
    const f = await interruptedFixture(t);
    if (variant === 'review') await f.reviewer('CHANGES_REQUESTED');
    if (variant === 'prefixMutation') await f.reviewer('APPROVED', 'fs.writeFileSync(require("node:path").join(req.repository_path,"source.txt"),"unverified prefix change");');
    const before = await snapshot(f.dir);
    const r = await f.recover(variant === 'checks' ? { testCommand: [process.execPath, '-e', 'process.exit(7)'] } : {}, {
      interrupt: async stage => {
        if (stage === 'beforeReview' && variant === 'sourceMutation') await writeFile(path.join(f.dir, 'source.txt'), 'concurrent writer');
        if (stage === 'beforeReview' && variant === 'stateMutation') await f.add('other');
      },
    });
    if (['tampered', 'stale'].includes(variant)) {
      assert.equal(r.status, 'READY', JSON.stringify(r));
      if (variant === 'tampered') await writeFile(path.join(f.dir, '.git/pi-conductor-evidence', r.handoffRef.split(':').at(-1) + '.json'), '{}');
      else await writeFile(path.join(f.dir, 'source.txt'), 'unexpected edit');
      const resumed = await executeAndReview({ ...r.resume, input: '{"operations":[]}' }, { directory: f.dir }, {
        invokeConductor: () => assert.fail('invalid handoff must not execute'),
      });
      assert.equal(resumed.status, 'BLOCKED');
    } else {
      assert.equal(r.status, 'BLOCKED', variant + JSON.stringify(r)); assert.equal(r.handoffRef, undefined);
      if (variant !== 'sourceMutation') assert.deepEqual(await snapshot(f.dir), before);
    }
    assert.equal(f.g('worktree', 'list', '--porcelain').split('\n').filter(line => line.startsWith('worktree ')).length, 1);
  }
});

test('a second interrupted rebase carries the same task from attempt four to five without a budget reset', integration, async t => {
  const f = await interruptedFixture(t);
  const first = await f.recover(); assert.equal(first.status, 'READY', JSON.stringify(first));
  await f.call('retry', { task_id: 'two', reason: 'Use first authenticated handoff' }); await f.call('start', { task_id: 'two' });
  const fourth = await f.attempt({ ...first.resume, input: '{"operations":[]}' });
  assert.equal(fourth.evidence.attempt, 4);
  await f.call('block', { task_id: 'two', reason: 'Second authorized rebase' });
  f.g('stash', 'push', '-u'); const next = await f.rebase(first.reconciliationRef); f.g('stash', 'pop');
  const second = await f.recover({ ...next, previousAttempt: fourth.evidence.reference });
  assert.equal(second.status, 'READY', JSON.stringify(second));
  assert.equal(second.consumedAttempts, 4); assert.equal(second.remainingAttempts, 1);
  await f.call('retry', { task_id: 'two', reason: 'Use second authenticated handoff; four attempts consumed' }); await f.call('start', { task_id: 'two' });
  const fifth = await f.attempt({ ...second.resume, input: '{"operations":[]}' }, 'PASSED');
  assert.equal(fifth.status, 'PASSED', JSON.stringify(fifth)); assert.equal(fifth.evidence.attempt, 5);
  await f.call('complete', { task_id: 'two', payload: { feature_id: 'F5', task_id: 'two', result: 'PASSED', source: 'conductor',
    reference: fifth.evidence.reference, summary: 'Verified at final allowed attempt after two rebases' } });
  const checkpoint = await checkpointVerifiedTask({ task: f.task, evidenceRef: fifth.evidence.reference, reconciliationRef: second.reconciliationRef,
    featureBaseRef: f.base, branch: 'feature/test', defaultBranch: 'main', protectedBranches: [], authorizationMode: 'manual' },
  { directory: f.dir }, f.options);
  assert.equal(checkpoint.ok, true, JSON.stringify(checkpoint));
  assert.equal((await f.validate({ reconciliationRef: second.reconciliationRef })).status, 'PASSED');
});

test('a terminal HEAD_CHANGED receipt preserves its consumed attempt and exact already-rebased task tree', integration, async t => {
  const f = await interruptedFixture(t, 2);
  // Return to the old feature HEAD in this disposable fixture, retaining pending source.
  f.g('stash', 'push', '-u'); f.g('reset', '--hard', f.taskArgs.baseRef); f.g('stash', 'pop');
  const changed = await executeAndReview({ ...f.taskArgs, previousAttempt: f.receipts.at(-1) }, { directory: f.dir }, {
    invokeConductor: async () => {
      await writeFile(path.join(f.dir, 'source.txt'), 'third attempt before rebase\r\n');
      f.g('stash', 'push', '-u'); f.g('rebase', 'main'); f.g('stash', 'pop');
      return { code: 2, stdout: JSON.stringify({ schema: 'conductor.result/v1', status: 'NEEDS_DESIGN', phase: 'review',
        execution: { success: true }, checks: ['build', 'test'].map(name => ({ name, exit_code: 0 })),
        review: { status: 'CHANGES_REQUESTED', findings: [{ message: 'Do not lose CRLF review findings when HEAD changes' }] } }) };
    },
  });
  assert.equal(changed.reason, 'HEAD_CHANGED'); assert.equal(changed.evidence.attempt, 3);
  const original = await readEvidence(f.dir, changed.evidence.reference);
  f.args.headRef = f.g('rev-parse', 'HEAD');
  assert.equal(original.before.head, f.taskArgs.baseRef); assert.equal(original.after.head, f.args.headRef);
  const before = await snapshot(f.dir);
  const recovered = await f.recover({ previousAttempt: changed.evidence.reference });
  assert.equal(recovered.status, 'READY', JSON.stringify(recovered)); assert.equal(recovered.consumedAttempts, 3);
  assert.deepEqual(await snapshot(f.dir), before); assert.match(recovered.resume.requirements, /Do not lose CRLF review findings/);
  const passed = await f.attempt({ ...recovered.resume, input: '{"operations":[]}' }, 'PASSED');
  assert.equal(passed.status, 'PASSED'); assert.equal(passed.evidence.attempt, 4);
});

test('interrupted recovery reaches independent review with mixed Cargo workspace and empty harness output', integration, async t => {
  const f = await interruptedFixture(t);
  const marker = 'test result: ok. 13 passed; 0 failed';
  const workspaceOutput = [
    'running 0 tests', 'test result: ok. 0 passed; 0 failed',
    marker + '; 0 ignored; 0 measured; 0 filtered out',
    'test result: ok. 20 passed; 0 failed', 'test result: ok. 5 passed; 0 failed',
    'Doc-tests messages', 'running 0 tests', 'test result: ok. 0 passed; 0 failed',
  ].join('\n');
  const r = await f.recover({ testCommand: [process.execPath, '-e', 'console.log(' + JSON.stringify(workspaceOutput) + ')'], testSuccessPattern: marker });
  assert.equal(r.status, 'READY', JSON.stringify(r));
  const prefix = await readFeatureEvidence(f.dir, r.reconciliationRef);
  assert.equal(prefix.checks.find(c => c.definition.name === 'test').stdout.trimEnd(), workspaceOutput);
  assert.equal(prefix.review.status, 'APPROVED');
  assert.match(JSON.parse(await readFile(f.capture, 'utf8')).requirements, /0 passed/);
  assert.equal(r.consumedAttempts, 3);
});

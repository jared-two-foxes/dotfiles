import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, mkdir, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { executeAndReview as executeTaskAttempt } from '../pi/agent/extensions/conductor/adapter.mjs';
import { inspectEvidence, digest, snapshot } from '../pi/agent/extensions/conductor/evidence.mjs';
import { scaffoldTasks, buildCommand, designReference } from '../pi/agent/extensions/scaffold/adapter.mjs';


async function executeAndReview(args, context, options) {
  return executeTaskAttempt(args, context, { ...options, invokeConductor: async (json, timeoutMs) => {
    const result = await options.invokeConductor(json, timeoutMs);
    const request = JSON.parse(json);
    const check = request.checks.find(c => c.name === 'test');
    const boundary = JSON.parse(check.args[1]);
    await writeFile(boundary.output, JSON.stringify(await snapshot(boundary.repository)));
    return result;
  } });
}

const designText = 'Approved: independent value model, then consumer. Preserve existing interfaces.';
const feature = { id: 'F3', title: 'Value feature', objective: 'Deliver value behavior',
  baseline: 'a'.repeat(40), branch: 'feature/test', context: designText, design_ref: 'sha256:context', acceptance_criteria: ['Consumer displays valid value'] };
const definition = (id, dependencies = []) => ({ id, title: id, objective: 'One bounded behavior: ' + id,
  acceptance_criteria: [id + ' handles valid and invalid values'], dependencies,
  constraints: ['Preserve existing interfaces'], context: 'Source: value.txt. Verification: assert valid and invalid inputs; run build and tests.' });
const task = { featureId: 'F3', taskId: 'model', designRef: designReference(designText) };
const requirements = 'model handles valid and invalid values; preserve existing interfaces. Consumer display deferred.';
function response(status = 'PASSED', patch = {}) {
  return { code: { PASSED: 0, NEEDS_DESIGN: 2, BLOCKED: 3 }[status], stderr: '', stdout: JSON.stringify({
    schema: 'conductor.result/v1', status, phase: 'review', execution: { success: true, operations_applied: 1 },
    checks: ['build', 'test'].map(name => ({ name, program: 'fixture', exit_code: 0,
      stdout: name === 'test' ? '2 tests passed (valid/invalid value)' : 'build succeeded', stderr: '' })),
    review: { status: status === 'PASSED' ? 'APPROVED' : 'CHANGES_REQUESTED' }, ...patch,
  }) };
}
async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'pi-task-workflow-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
  await writeFile(path.join(dir, 'value.txt'), 'before');
  git('add', 'value.txt'); git('commit', '-qm', 'baseline');
  return { dir, git, args: { task, requirements, baseRef: git('rev-parse', 'HEAD'),
    input: JSON.stringify({ operations: [{ type: 'edit_file', path: 'value.txt', edits: [{ oldText: 'before', newText: 'after' }] }] }),
    buildCommand: ['fixture', 'build'], testCommand: ['fixture', 'test'] } };
}

test('approved design snapshot is bound before native persistence, with complete dependent definitions', () => {
  const init = buildCommand({ operation: 'init', feature_id: 'F3', payload: feature });
  const persisted = JSON.parse(init.input);
  assert.equal(persisted.context, designText);
  assert.equal(persisted.design_ref, 'sha256:' + digest(designText));
  assert.equal(feature.design_ref, 'sha256:context'); // do not mutate caller input
  const definitions = [definition('model'), definition('consumer', ['model'])];
  assert.deepEqual(JSON.parse(buildCommand({ operation: 'add', feature_id: 'F3', payload: definitions }).input), definitions);
  assert.throws(() => buildCommand({ operation: 'init', feature_id: 'F3', payload: { ...persisted, context: 'changed' } }), /digest mismatch/);
  assert.throws(() => buildCommand({ operation: 'add', feature_id: 'F3', payload: [{ ...definition('bad'), acceptance_criteria: [] }] }));
});

test('one task retains real request/raw response and exposes read-only recovery evidence', async t => {
  const f = await fixture(t);
  let calls = 0;
  const actual = response();
  const result = await executeAndReview(f.args, { directory: f.dir }, { invokeConductor: async json => {
    calls++;
    const sent = JSON.parse(json);
    assert.equal(sent.review.requirements, requirements);
    assert.equal(sent.execution.operations.length, 1);
    await writeFile(path.join(f.dir, 'value.txt'), 'after');
    return actual;
  } });
  assert.equal(calls, 1);
  assert.equal(result.status, 'PASSED');
  assert.match(result.evidence.reference, /^pi-evidence:sha256:[a-f0-9]{64}$/);
  const fresh = await import('../pi/agent/extensions/conductor/evidence.mjs?fresh-session');
  const recovered = await fresh.inspectEvidence(result.evidence.reference, { directory: f.dir });
  assert.equal(recovered.ok, true);
  assert.equal(recovered.structurallyVerified, true);
  assert.equal(recovered.matchesWorkingTree, true);
  assert.deepEqual(recovered.record.task, task);
  assert.deepEqual(recovered.record.response, actual);
  assert.equal(recovered.record.args.baseRef, f.args.baseRef);
  assert.equal(recovered.record.request.review.requirements, requirements);
  const intent = await inspectEvidence(recovered.record.startedReference, { directory: f.dir });
  assert.equal(intent.record.result.stage, 'STARTED');
  assert.equal(intent.structurallyVerified, false);
  await writeFile(path.join(f.dir, 'value.txt'), 'unexpected later changes');
  assert.equal((await inspectEvidence(result.evidence.reference, { directory: f.dir })).matchesWorkingTree, false);
  assert.equal(f.git('rev-parse', 'HEAD'), f.args.baseRef);
});

test('task receipts retain workflow timeout and corrections may increase it without changing fixed inputs', async t => {
  const f = await fixture(t);
  const originalTimeout = 300000;
  const increasedTimeout = 5400000;
  const first = await executeAndReview({ ...f.args, workflowTimeoutMs: originalTimeout }, { directory: f.dir }, {
    invokeConductor: async (_json, timeoutMs) => { assert.equal(timeoutMs, originalTimeout); return response('NEEDS_DESIGN'); },
  });
  assert.equal(first.status, 'NEEDS_DESIGN');
  assert.equal(first.evidence.attempt, 1);
  const firstRecord = await inspectEvidence(first.evidence.reference, { directory: f.dir });
  assert.equal(firstRecord.record.args.workflowTimeoutMs, originalTimeout);
  const corrected = await executeAndReview({ ...f.args, workflowTimeoutMs: increasedTimeout, previousAttempt: first.evidence.reference }, { directory: f.dir }, {
    invokeConductor: async (_json, timeoutMs) => { assert.equal(timeoutMs, increasedTimeout); return response('NEEDS_DESIGN'); },
  });
  assert.equal(corrected.status, 'NEEDS_DESIGN');
  assert.equal(corrected.evidence.attempt, 2);
  const correctedRecord = await inspectEvidence(corrected.evidence.reference, { directory: f.dir });
  assert.equal(correctedRecord.record.args.workflowTimeoutMs, increasedTimeout);
  assert.equal(correctedRecord.record.args.baseRef, f.args.baseRef);
  assert.equal(correctedRecord.record.args.requirements, f.args.requirements);
  assert.deepEqual(correctedRecord.record.args.buildCommand, f.args.buildCommand);
  assert.deepEqual(correctedRecord.record.args.testCommand, f.args.testCommand);
  assert.equal(correctedRecord.record.attempt, 2);
});

test('corrections preserve baseline/requirements and count attempts without automatic retry', async t => {
  const f = await fixture(t);
  let last;
  for (let attempt = 1; attempt <= 5; attempt++) {
    const result = await executeAndReview({ ...f.args, previousAttempt: last }, { directory: f.dir }, {
      invokeConductor: async () => response('NEEDS_DESIGN'),
    });
    assert.equal(result.status, 'NEEDS_DESIGN');
    assert.equal(result.evidence.attempt, attempt);
    last = result.evidence.reference;
  }
  const limited = await executeAndReview({ ...f.args, previousAttempt: last }, { directory: f.dir }, {
    invokeConductor: () => assert.fail('must stop at five'),
  });
  assert.match(limited.message, /Five-attempt limit/);
  for (const patch of [{ requirements: 'weakened' }, { task: { ...task, taskId: 'consumer' } }, { testCommand: ['true'] }]) {
    const invalid = await executeAndReview({ ...f.args, ...patch, previousAttempt: last }, { directory: f.dir }, {
      invokeConductor: () => assert.fail('must not invoke'),
    });
    assert.equal(invalid.status, 'BLOCKED');
  }
});

test('partial changes require the exact prior receipt, and current-state correction can pass', async t => {
  const f = await fixture(t);
  const first = await executeAndReview(f.args, { directory: f.dir }, { invokeConductor: async () => {
    await writeFile(path.join(f.dir, 'value.txt'), 'partial');
    return response('NEEDS_DESIGN', { phase: 'verification', checks: [{ name: 'build', exit_code: 1 }], review: null });
  } });
  assert.equal(first.status, 'NEEDS_DESIGN');
  const args = { ...f.args, previousAttempt: first.evidence.reference,
    input: JSON.stringify({ operations: [{ type: 'edit_file', path: 'value.txt', edits: [{ oldText: 'partial', newText: 'after' }] }] }) };
  const corrected = await executeAndReview(args, { directory: f.dir }, { invokeConductor: async json => {
    assert.equal(JSON.parse(json).execution.operations[0].edits[0].oldText, 'partial');
    await writeFile(path.join(f.dir, 'value.txt'), 'after');
    return response();
  } });
  assert.equal(corrected.status, 'PASSED');
  assert.equal(corrected.evidence.attempt, 2);
  const replay = await executeAndReview(args, { directory: f.dir }, { invokeConductor: () => assert.fail('cannot replay after tree changed') });
  assert.equal(replay.status, 'BLOCKED');
});

test('missing, tampered and incomplete verification cannot provide successful evidence', async t => {
  const f = await fixture(t);
  for (const patch of [{ checks: [] }, { review: null }, { execution: { success: false } },
    { review: { status: 'INDETERMINATE' } }, { checks: [{ name: 'build', exit_code: 0 }, { name: 'test', exit_code: 1 }] }]) {
    const result = await executeAndReview(f.args, { directory: f.dir }, { invokeConductor: async () => response('PASSED', patch) });
    assert.equal(result.status, 'BLOCKED');
    assert.equal(result.reason, 'INCOMPLETE_VERIFICATION');
    assert.equal((await inspectEvidence(result.evidence.reference, { directory: f.dir })).structurallyVerified, false);
  }
  assert.equal((await inspectEvidence('invented', { directory: f.dir })).ok, false);
  assert.equal((await inspectEvidence('pi-evidence:sha256:' + 'a'.repeat(64), { directory: f.dir })).ok, false);
  const result = await executeAndReview(f.args, { directory: f.dir }, { invokeConductor: async () => response() });
  const dir = f.git('rev-parse', '--git-path', 'pi-conductor-evidence');
  await writeFile(path.resolve(f.dir, dir, result.evidence.reference.split(':').at(-1) + '.json'), '{}');
  assert.equal((await inspectEvidence(result.evidence.reference, { directory: f.dir })).ok, false);
});

test('blocked responses retain partial changes with no automatic invocation or retry', async t => {
  const f = await fixture(t);
  let calls = 0;
  const result = await executeAndReview(f.args, { directory: f.dir }, { invokeConductor: async () => {
    calls++; await writeFile(path.join(f.dir, 'value.txt'), 'partial');
    return response('BLOCKED', { review: null, error: 'provider unavailable' });
  } });
  assert.equal(result.status, 'BLOCKED');
  assert.equal(calls, 1);
  assert.equal(await readFile(path.join(f.dir, 'value.txt'), 'utf8'), 'partial');
  assert.equal((await inspectEvidence(result.evidence.reference, { directory: f.dir })).structurallyVerified, false);
});

test('Scaffold bookkeeping must be ignored so it cannot pollute the review diff', async t => {
  const f = await fixture(t);
  await mkdir(path.join(f.dir, '.scaffold'));
  await writeFile(path.join(f.dir, '.scaffold/tasks.json'), '{}');
  const result = await executeAndReview(f.args, { directory: f.dir }, {
    invokeConductor: () => assert.fail('state would enter review diff'),
  });
  assert.equal(result.reason, 'SCAFFOLD_REVIEW_SCOPE');
});

test('receipt retention must succeed before applying operations; HEAD changes never complete', async t => {
  const f = await fixture(t);
  const dir = path.resolve(f.dir, f.git('rev-parse', '--git-path', 'pi-conductor-evidence'));
  await writeFile(dir, 'not a directory');
  const refused = await executeAndReview(f.args, { directory: f.dir }, { invokeConductor: () => assert.fail('must not apply') });
  assert.equal(refused.status, 'BLOCKED');
  await rm(dir);
  const changed = await executeAndReview(f.args, { directory: f.dir }, { invokeConductor: async () => {
    f.git('commit', '--allow-empty', '-qm', 'unexpected HEAD'); return response();
  } });
  assert.equal(changed.status, 'BLOCKED');
  assert.equal(changed.reason, 'HEAD_CHANGED');
});

// This is a scripted Pi/tool conversation, not an LLM compliance test. Scaffold
// is real, Conductor responses are deterministic fixtures; production never
// uses this launcher or runs a new orchestration loop.
test('real Scaffold rejects the original execution-first lifecycle', {
  skip: !process.env.SCAFFOLD_SOURCE ? 'Set SCAFFOLD_SOURCE' : false,
}, async t => {
  const f = await fixture(t);
  const { invoke } = await import('../pi/agent/extensions/scaffold/adapter.mjs');
  const invokeScaffold = async (_program, args, options) => invoke('python3', ['-c',
    'import sys;sys.path.insert(0,sys.argv.pop(1));from scaffold_cli.cli import main;main()',
    path.join(process.env.SCAFFOLD_SOURCE, 'src'), ...args], options);
  const call = (operation, extra = {}) => scaffoldTasks({operation, feature_id:'F3', ...extra}, {directory:f.dir}, {invokeScaffold});
  const initialized = await call('init', {payload:feature});
  assert.equal(initialized.ok, true, JSON.stringify(initialized));
  assert.equal(initialized.data.feature.workflow.phase, 'design');
  assert.ok(initialized.data.feature.tasks.F3);
  assert.equal((await call('add', {payload:[definition('model')]})).ok, true);
  assert.equal((await call('next')).data.task, null);
  const rejected = await call('start', {task_id:'model'});
  assert.equal(rejected.ok, false);
  assert.match(rejected.scaffold_error.error, /design/);
  const versionOne = JSON.parse(await readFile(path.join(f.dir,'.scaffold/tasks.json'),'utf8'));
  versionOne.schema_version = 1;
  await writeFile(path.join(f.dir,'.scaffold/tasks.json'), JSON.stringify(versionOne));
  const old = await call('retry', {task_id:'model',reason:'Attempt to use old state'});
  assert.equal(old.ok, false); assert.match(old.scaffold_error.error, /schema_version/);
});

test('workflow guidance covers handoff, task-scoped review, failure classification, recovery and approvals', async () => {
  const design = await readFile(new URL('../pi/agent/skills/design/SKILL.md', import.meta.url), 'utf8');
  for (const phrase of ['Mandatory decomposition', 'Before generating Executor', 'approve_feature_direction',
    'Verification:', 'ancestor dependencies', 'future feature criteria',
    'previousAttempt', 'inspect_conductor_evidence', 'Oversized task', 'completed descendants',
    'parent remains incomplete', 'five total application attempts', 'two consecutive attempts',
    'Conversational memory is not authoritative', 'checkpoint required', 'single approval']) {
    assert.ok(design.includes(phrase), phrase);
  }
  assert.ok(design.indexOf('### Feature planning') < design.indexOf('## 4. Prepare executor'));
});

const approvedTaskDesign = [
  'Task design: model for F3. Represent values as bounded integers; reject invalid input before construction.',
  'Usage: constructor validates; consumer reads the validated value. Tests cover bounds and invalid input.',
  'Task design approval record: user explicitly approved this model preview and its validation contract.',
  requirements,
].join('\n');

test('existing attempt evidence retains approved local design independently of immutable architecture and definitions', async t => {
  const f = await fixture(t);
  const architecture = JSON.parse(buildCommand({ operation: 'init', feature_id: 'F3', payload: feature }).input);
  const definitions = JSON.parse(buildCommand({ operation: 'add', feature_id: 'F3', payload: [definition('model')] }).input);
  assert.ok(!architecture.context.includes('bounded integers'));
  assert.ok(!definitions[0].context.includes('bounded integers'));
  let calls = 0;
  const result = await executeAndReview({ ...f.args, requirements: approvedTaskDesign }, { directory: f.dir }, {
    invokeConductor: async json => {
      calls++;
      assert.equal(JSON.parse(json).review.requirements, approvedTaskDesign);
      await writeFile(path.join(f.dir, 'value.txt'), 'after');
      return response();
    },
  });
  assert.equal(result.status, 'PASSED');
  const fresh = await import('../pi/agent/extensions/conductor/evidence.mjs?local-design-recovery');
  const recovered = await fresh.inspectEvidence(result.evidence.reference, { directory: f.dir });
  assert.equal(recovered.record.request.review.requirements, approvedTaskDesign);
  const intent = await fresh.inspectEvidence(recovered.record.startedReference, { directory: f.dir });
  assert.equal(intent.record.args.requirements, approvedTaskDesign);
  assert.equal(intent.structurallyVerified, false); // approval text is not successful execution
  assert.equal(calls, 1); // recovery never applies operations
  assert.equal(architecture.design_ref, task.designRef);
  assert.equal(architecture.context, designText);
  assert.deepEqual(definitions[0], definition('model'));
});

test('real Scaffold permits recursive design decomposition before any implementation attempt', {
  skip: !process.env.SCAFFOLD_SOURCE || process.platform === 'win32' ? 'Set SCAFFOLD_SOURCE (POSIX launcher)' : false,
}, async t => {
  const f = await fixture(t);
  const bin = await mkdtemp(path.join(tmpdir(), 'pi-design-scaffold-bin-'));
  t.after(() => rm(bin, { recursive: true, force: true }));
  await writeFile(path.join(bin, 'scaffold'), '#!/usr/bin/env python3\nimport sys\nsys.path.insert(0, ' +
    JSON.stringify(path.resolve(process.env.SCAFFOLD_SOURCE, 'src')) + ')\nfrom scaffold_cli.cli import main\nmain()\n');
  await chmod(path.join(bin, 'scaffold'), 0o755);
  // Invoke the actual CLI explicitly through the existing adapter injection, without changing PATH.
  const { invoke } = await import('../pi/agent/extensions/scaffold/adapter.mjs');
  const call = args => scaffoldTasks({ feature_id: 'F3', ...args }, { directory: f.dir }, {
    invokeScaffold: (_program, args, options) => invoke(path.join(bin, 'scaffold'), args, options),
  });
  assert.equal((await call({ operation: 'init', payload: feature })).ok, true);
  assert.equal((await call({ operation: 'add', payload: [definition('model'), definition('consumer', ['model'])] })).ok, true);
  const before = (await call({ operation: 'list' })).data.feature;
  assert.equal((await call({ operation: 'next' })).data.task, null);
  assert.equal((await call({ operation: 'design-next' })).data.task.id, 'F3');
  const children = [definition('contract'), definition('writes', ['contract']), definition('queries', ['writes'])];
  const split = await call({ operation: 'decompose', task_id: 'model', payload: children });
  assert.equal(split.ok, true, JSON.stringify(split));
  const after = (await call({ operation: 'list' })).data.feature;
  assert.equal(after.design_ref, before.design_ref);
  assert.equal(after.context, before.context);
  assert.equal(after.tasks.model.status, 'decomposed');
  for (const key of ['objective', 'acceptance_criteria', 'context', 'constraints', 'dependencies']) {
    assert.deepEqual(after.tasks.model[key], before.tasks.model[key]);
  }
  assert.deepEqual(after.tasks.model.history.slice(0, before.tasks.model.history.length), before.tasks.model.history);
  assert.ok(!after.tasks.model.history.some(h => h.event === 'failed' || h.event === 'started'));
  for (const child of children) {
    assert.equal(after.tasks[child.id].parent_id, 'model');
    assert.deepEqual(after.tasks[child.id].constraints, child.constraints);
    assert.equal(after.tasks[child.id].context, child.context);
  }
  assert.deepEqual(after.tasks.consumer.dependencies, ['model']);
  assert.equal((await call({ operation: 'next' })).data.task, null);
  assert.equal((await call({ operation: 'start', task_id: 'model' })).ok, false);
  assert.equal(f.git('rev-parse', 'HEAD'), f.args.baseRef);
  assert.equal(await readFile(path.join(f.dir, 'value.txt'), 'utf8'), 'before');
  // A fresh session has graph and architecture, but no invented task design approval.
  const fresh = await import('../pi/agent/extensions/scaffold/adapter.mjs?design-decomposition-recovery');
  const recovered = await fresh.scaffoldTasks({ operation: 'list', feature_id: 'F3' }, { directory: f.dir }, {
    invokeScaffold: (_program, args, options) => invoke(path.join(bin, 'scaffold'), args, options),
  });
  assert.deepEqual(recovered.data.feature, after);
});

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
  return executeTaskAttempt(args, context, { ...options, invokeConductor: async json => {
    const result = await options.invokeConductor(json);
    const request = JSON.parse(json);
    const check = request.checks.find(c => c.name === 'test');
    const boundary = JSON.parse(check.args[1]);
    await writeFile(boundary.output, JSON.stringify(await snapshot(boundary.repository)));
    return result;
  } });
}

const designText = 'Approved: independent value model, then consumer. Preserve existing interfaces.';
const feature = { id: 'F3', title: 'Value feature', objective: 'Deliver value behavior',
  context: designText, design_ref: 'sha256:context', acceptance_criteria: ['Consumer displays valid value'] };
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
test('real native handoff: dependent task becomes ready but cannot cross an unresolved checkpoint; recursive recovery', {
  skip: !process.env.SCAFFOLD_SOURCE || process.platform === 'win32' ? 'Set SCAFFOLD_SOURCE (POSIX launcher)' : false,
}, async t => {
  const f = await fixture(t);
  const bin = await mkdtemp(path.join(tmpdir(), 'pi-phase3-scaffold-bin-'));
  t.after(() => rm(bin, { recursive: true, force: true }));
  await writeFile(path.join(bin, 'scaffold'), '#!/usr/bin/env python3\nimport sys\nsys.path.insert(0, ' +
    JSON.stringify(path.resolve(process.env.SCAFFOLD_SOURCE, 'src')) + ')\nfrom scaffold_cli.cli import main\nmain()\n');
  await chmod(path.join(bin, 'scaffold'), 0o755);
  await writeFile(path.join(f.dir, '.git/info/exclude'), '.scaffold/\n');
  const previous = process.env.PATH;
  process.env.PATH = bin + path.delimiter + previous;
  t.after(() => { process.env.PATH = previous; });
  const call = async (operation, task_id, payload, reason) => {
    const result = await scaffoldTasks({ operation, feature_id: 'F3', ...(task_id ? { task_id } : {}),
      ...(payload ? { payload } : {}), ...(reason ? { reason } : {}) }, { directory: f.dir });
    assert.equal(result.ok, true, JSON.stringify(result)); return result.data;
  };
  await call('init', undefined, feature);
  // Invalid graphs must fail in Scaffold itself, not in a parallel Pi graph engine.
  const cycle = await scaffoldTasks({ operation: 'add', feature_id: 'F3', payload: [definition('a', ['b']), definition('b', ['a'])] }, { directory: f.dir });
  assert.equal(cycle.ok, false);
  const missing = await scaffoldTasks({ operation: 'add', feature_id: 'F3', payload: [definition('a', ['missing'])] }, { directory: f.dir });
  assert.equal(missing.ok, false);
  await call('add', undefined, [definition('model'), definition('consumer', ['model'])]);
  assert.equal((await call('next')).task.id, 'model');
  await call('start', 'model');
  const passed = await executeAndReview(f.args, { directory: f.dir }, { invokeConductor: async () => {
    await writeFile(path.join(f.dir, 'value.txt'), 'after'); return response();
  } });
  const recovered = await inspectEvidence(passed.evidence.reference, { directory: f.dir });
  assert.equal(recovered.matchesWorkingTree && recovered.structurallyVerified, true);
  await call('complete', 'model', { feature_id: 'F3', task_id: 'model', result: 'PASSED', source: 'conductor',
    reference: passed.evidence.reference, summary: 'Fixture build and 2 relevant tests succeeded; independent review fixture approved' });
  assert.equal((await call('next')).task.id, 'consumer');
  let calls = 0;
  const barrier = await executeAndReview({ ...f.args, task: { ...task, taskId: 'consumer' } }, { directory: f.dir }, {
    invokeConductor: () => { calls++; return response(); },
  });
  assert.equal(barrier.reason, 'CHECKPOINT_REQUIRED'); assert.equal(calls, 0);
  assert.equal((await call('list')).feature.tasks.consumer.status, 'pending');
  // Simulate the separately authorised human checkpoint, never production auto-commit.
  f.git('add', 'value.txt'); f.git('commit', '-qm', 'authorised checkpoint');
  await call('start', 'consumer');
  const fresh = await import('../pi/agent/extensions/scaffold/adapter.mjs?phase3-session');
  const state = await fresh.scaffoldTasks({ operation: 'list', feature_id: 'F3' }, { directory: f.dir });
  assert.equal(state.data.feature.design_ref, task.designRef);
  assert.equal(state.data.feature.tasks.consumer.status, 'in_progress');
  assert.equal((await call('next')).task, null); // interrupted does not mean done
  await call('fail', 'consumer', undefined, 'Oversized remaining work; no verified consumer changes');
  await call('decompose', 'consumer', [definition('parse'), definition('display', ['parse'])]);
  await call('decompose', 'parse', [definition('validate')]);
  assert.equal((await call('next')).task.id, 'validate');
  const listed = (await call('list')).feature.tasks;
  assert.equal(listed.model.status, 'completed');
  assert.equal(listed.consumer.status, 'decomposed');
  assert.deepEqual(listed.consumer.acceptance_criteria, definition('consumer').acceptance_criteria);
  await call('block', 'consumer', undefined, 'Awaiting boundary decision');
  assert.equal((await call('next')).task, null);
  await call('retry', 'consumer', undefined, 'Boundary decision resolved; explicit resume');
  const premature = await scaffoldTasks({ operation: 'start', feature_id: 'F3', task_id: 'consumer' }, { directory: f.dir });
  assert.equal(premature.ok, false);
  for (const id of ['validate', 'parse', 'display', 'consumer']) {
    assert.equal((await call('next')).task.id, id);
    await call('start', id);
    const checked = await executeAndReview({ ...f.args, task: { ...task, taskId: id },
      baseRef: f.git('rev-parse', 'HEAD'), input: '{"operations":[]}',
      requirements: definition(id).acceptance_criteria.join('; ') }, { directory: f.dir }, {
      invokeConductor: async () => response(),
    });
    assert.equal(checked.status, 'PASSED');
    await call('complete', id, { feature_id: 'F3', task_id: id, result: 'PASSED', source: 'conductor',
      reference: checked.evidence.reference, summary: 'Mocked checks and review for explicit parent/child criteria' });
    if (id === 'display') assert.equal((await call('list')).feature.tasks.consumer.status, 'decomposed');
  }
  // Mutation after approval is detected when recovering full feature state.
  const stateFile = path.join(f.dir, '.scaffold/tasks.json');
  const raw = JSON.parse(await readFile(stateFile, 'utf8')); raw.features.F3.context = 'silently changed';
  await writeFile(stateFile, JSON.stringify(raw));
  assert.equal((await fresh.scaffoldTasks({ operation: 'list', feature_id: 'F3' }, { directory: f.dir })).ok, false);
});

test('workflow guidance covers handoff, task-scoped review, failure classification, recovery and approvals', async () => {
  const design = await readFile(new URL('../pi/agent/skills/design/SKILL.md', import.meta.url), 'utf8');
  for (const phrase of ['Mandatory decomposition', 'before generating Executor', 'Confirm consequential decomposition',
    'Verification:', 'ancestor dependencies', 'future feature criteria',
    'previousAttempt', 'inspect_conductor_evidence', 'Oversized task', 'completed descendants',
    'parent remains incomplete', 'five total application attempts', 'two consecutive attempts',
    'Conversational memory is not authoritative', 'checkpoint required', 'separate explicit execution confirmation']) {
    assert.ok(design.includes(phrase), phrase);
  }
  assert.ok(design.indexOf('### Feature planning') < design.indexOf('## 4. Prepare executor'));
});

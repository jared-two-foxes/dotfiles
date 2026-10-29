import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { git } from '../pi/agent/extensions/conductor/git-tree.mjs';
import { snapshot, readEvidence } from '../pi/agent/extensions/conductor/evidence.mjs';
import { executeAndReview } from '../pi/agent/extensions/conductor/adapter.mjs';
import { checkpointVerifiedTask } from '../pi/agent/extensions/conductor/checkpoint.mjs';
import { scaffoldTasks, designReference } from '../pi/agent/extensions/scaffold/adapter.mjs';
import { issueDesignRequirements } from '../pi/agent/extensions/conductor/issue-state.mjs';
import { suspendIssue, resumeIssue } from '../pi/agent/extensions/conductor/issue-recovery.mjs';
import { authenticateAttemptChain } from '../pi/agent/extensions/conductor/task-chain.mjs';
import { reconcileFeature } from '../pi/agent/extensions/conductor/reconciliation.mjs';
import { validateFeature } from '../pi/agent/extensions/conductor/feature.mjs';
import { prepareIssueHandoff, inspectIssueHandoff, inspectIssueAttempt } from '../pi/agent/extensions/conductor/issue-context.mjs';
import { checkpointHistory } from '../pi/agent/extensions/conductor/history.mjs';
const integration = { skip: !process.env.SCAFFOLD_SOURCE ? 'Set SCAFFOLD_SOURCE to recursive-issues Scaffold checkout' : false };
async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'pi-issues-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  const g = (...args) => git(dir, args);
  g('config', 'user.name', 'Test'); g('config', 'user.email', 'test@example.invalid'); g('config', 'core.autocrlf', 'false');
  await writeFile(path.join(dir, '.gitignore'), '.scaffold/\n');
  await writeFile(path.join(dir, 'source.txt'), 'base\n');
  g('add', '.'); g('commit', '-qm', 'baseline'); g('switch', '-qc', 'feature/issues');
  const base = g('rev-parse', 'HEAD'), designRef = designReference('User ticket: preserve behavior. Baseline ' + base);
  const scaffoldOptions = { invokeScaffold: async (_program, args, ctx) => {
    try { return { code: 0, stdout: execFileSync(process.env.PYTHON ?? 'python3', ['-c',
      'import sys;sys.path.insert(0,sys.argv.pop(1));from scaffold_cli.cli import main;main()',
      path.join(process.env.SCAFFOLD_SOURCE, 'src'), ...args], { cwd: ctx.cwd, input: ctx.input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }) }; }
    catch (e) { return { code: e.status, stderr: e.stderr?.toString() }; }
  } };
  const call = async (operation, extra = {}) => {
    const r = await scaffoldTasks({ operation, feature_id: 'F', ...extra }, { directory: dir }, scaffoldOptions);
    assert.equal(r.ok, true, JSON.stringify(r)); return r.data;
  };
  await call('init', { payload: { id: 'F', title: 'Ticket', objective: 'Preserve behavior', acceptance_criteria: ['Behavior works'],
    design_ref: designRef, context: 'User ticket: preserve behavior. Baseline ' + base, baseline: base, branch: 'feature/issues' } });
  const approve = async (id, parent = false) => call('design-record', { task_id: id,
    payload: { summary: 'Approved solution ' + id, verification: 'Regression tests for ' + id,
      approval: 'User confirmed design ' + id, disposition: parent ? 'decomposed' : 'leaf' } });
  const add = async (parent, ids) => call('decompose', { task_id: parent, payload: ids.map(id => ({ id, title: id,
    objective: 'Deliver ' + id, acceptance_criteria: ['Verified ' + id], dependencies: [], context: 'Verification: focused regression',
    origin: { kind: 'design', reference: 'F' } })) });
  const binding = id => ({ featureId: 'F', taskId: id, designRef });
  const scope = id => ({ task: binding(id), featureBaseRef: base, branch: 'feature/issues', defaultBranch: 'main', protectedBranches: [] });
  const args = async id => ({ task: binding(id), baseRef: g('rev-parse', 'HEAD'), input: '{"operations":[]}',
    requirements: (await call('list')).feature.tasks[id].acceptance_criteria.join('\n') + issueDesignRequirements((await call('list')).feature.tasks[id]),
    buildCommand: ['build'], testCommand: ['test'] });
  async function run(a, status = 'PASSED', change = async () => {}) {
    return executeAndReview(a, { directory: dir }, { scaffoldOptions, invokeConductor: async json => {
      await change();
      const request = JSON.parse(json), boundary = JSON.parse(request.checks[1].args[1]);
      await writeFile(boundary.output, JSON.stringify(await snapshot(dir)));
      return { code: status === 'PASSED' ? 0 : 2, stdout: JSON.stringify({ schema: 'conductor.result/v1', status, phase: 'review',
        execution: { success: true }, checks: ['build', 'test'].map(name => ({ name, exit_code: 0 })),
        review: { status: status === 'PASSED' ? 'APPROVED' : 'CHANGES_REQUESTED', findings: status === 'PASSED' ? [] : [{ message: 'Missing prerequisite and regression' }] } }) };
    } });
  }
  async function finish(id, a, change, checkpointOptions = {}) {
    if (!a) { await call('start', { task_id: id }); a = await args(id); }
    const r = await run(a, 'PASSED', change); assert.equal(r.status, 'PASSED', JSON.stringify(r));
    await call('complete', { task_id: id, payload: { feature_id: 'F', task_id: id, source: 'conductor', result: 'PASSED', reference: r.evidence.reference, summary: 'Checks and review passed' } });
    const c = await checkpointVerifiedTask({ ...scope(id), evidenceRef: r.evidence.reference, authorizationMode: 'manual', reconciliationRef: checkpointOptions.reconciliationRef },
      { directory: dir }, { scaffoldOptions, authorize: async () => true, ...checkpointOptions });
    if (!checkpointOptions.interrupt) assert.equal(c.ok, true, JSON.stringify(c)); return { ...c, evidenceRef: r.evidence.reference };
  }
  const options = { scaffoldOptions, authorize: async () => true };
  return { dir, g, base, call, approve, add, binding, scope, args, run, finish, options };
}

test('full downward design then upward implementation has one checkpoint per issue including empty parents', integration, async t => {
  const f = await fixture(t);
  await f.add('F', ['api']); await f.approve('F', true);
  await f.add('api', ['types']); await f.approve('api', true); await f.approve('types');
  const early = await f.run({ task: f.binding('types'), baseRef: f.base, input: '{"operations":[]}', requirements: 'unapproved', buildCommand: ['build'], testCommand: ['test'] });
  assert.equal(early.status, 'BLOCKED');
  await f.call('design-finish');
  await f.finish('types', null, () => writeFile(path.join(f.dir, 'types.txt'), 'implemented\n'));
  await f.finish('api'); await f.finish('F');
  const feature = (await f.call('list')).feature;
  const history = await checkpointHistory(f.dir, feature, { head: f.g('rev-parse', 'HEAD'), baseline: f.base, branch: 'feature/issues' });
  assert.deepEqual(history.map(c => c.taskId), ['types', 'api', 'F']);
  assert.equal(f.g('rev-list', '--count', f.base + '..HEAD'), '3');
  assert.equal((await f.call('next')).task, null);
});

test('review discovery parks staged and untracked work, designs child, checkpoints it and resumes attempt four', integration, async t => {
  const f = await fixture(t); await f.approve('F'); await f.call('design-finish'); await f.call('start', { task_id: 'F' });
  let a = await f.args('F'), latest;
  for (let n = 1; n <= 3; n++) {
    const r = await f.run(a, 'NEEDS_DESIGN', async () => {
      await writeFile(path.join(f.dir, 'source.txt'), 'partial parent\n'); f.g('add', 'source.txt');
      await writeFile(path.join(f.dir, 'new.txt'), 'untracked parent\n');
    });
    assert.equal(r.evidence.attempt, n); latest = r.evidence.reference; a = { ...a, previousAttempt: latest };
  }
  const original = await snapshot(f.dir);
  const denied = await suspendIssue({ ...f.scope('F'), previousAttempt: latest, reason: 'Missing prerequisite' }, { directory: f.dir }, { ...f.options, authorize: async () => false });
  assert.equal(denied.status, 'BLOCKED'); assert.deepEqual(await snapshot(f.dir), original);
  const parked = await suspendIssue({ ...f.scope('F'), previousAttempt: latest, reason: 'Missing prerequisite' }, { directory: f.dir }, f.options);
  assert.equal(parked.status, 'DESIGN', JSON.stringify(parked)); assert.equal(parked.consumedAttempts, 3);
  assert.equal((await snapshot(f.dir)).clean, true); assert.equal(f.g('rev-parse', 'HEAD'), f.base);
  await f.add('F', ['prerequisite']); await f.approve('F', true); await f.approve('prerequisite'); await f.call('design-finish');
  await f.finish('prerequisite', null, () => writeFile(path.join(f.dir, 'prerequisite.txt'), 'prerequisite\n'));
  const resumed = await resumeIssue({ ...f.scope('F'), suspensionRef: parked.suspensionRef }, { directory: f.dir }, f.options);
  assert.equal(resumed.status, 'READY', JSON.stringify(resumed)); assert.equal(resumed.consumedAttempts, 3);
  assert.equal(await readFile(path.join(f.dir, 'source.txt'), 'utf8'), 'partial parent\n');
  assert.equal(await readFile(path.join(f.dir, 'new.txt'), 'utf8'), 'untracked parent\n');
  assert.match(f.g('diff', '--cached'), /partial parent/);
  assert.match(resumed.resume.requirements, /Missing prerequisite and regression/);
  assert.equal(resumed.resume.input, undefined);
  await f.call('start', { task_id: 'F' });
  const bypass = await f.run(await f.args('F')); assert.equal(bypass.status, 'BLOCKED');
  const c = await f.finish('F', { ...resumed.resume, input: '{"operations":[]}' });
  const receipt = await readEvidence(f.dir, c.evidenceRef); assert.equal(receipt.attempt, 4);
  const chain = await authenticateAttemptChain(f.dir, c.evidenceRef, f.binding('F'));
  assert.deepEqual(chain.records.map(r => r.attempt), [1, 2, 3, 3, 4]);
  assert.match(f.g('stash', 'list'), /Pi issue suspension/);
  const feature = (await f.call('list')).feature;
  assert.deepEqual((await checkpointHistory(f.dir, feature, { head: c.commit, baseline: f.base, branch: 'feature/issues' })).map(c => c.taskId), ['prerequisite', 'F']);
});

test('conflicting prerequisite changes block restoration and retain saved source and attempt history', integration, async t => {
  const f = await fixture(t); await f.approve('F'); await f.call('design-finish'); await f.call('start', { task_id: 'F' });
  const r = await f.run(await f.args('F'), 'NEEDS_DESIGN', () => writeFile(path.join(f.dir, 'source.txt'), 'parent change\n'));
  const parked = await suspendIssue({ ...f.scope('F'), previousAttempt: r.evidence.reference, reason: 'Prerequisite conflict' }, { directory: f.dir }, f.options);
  assert.equal(parked.status, 'DESIGN', JSON.stringify(parked));
  await f.add('F', ['fix']); await f.approve('F', true); await f.approve('fix'); await f.call('design-finish');
  await f.finish('fix', null, () => writeFile(path.join(f.dir, 'source.txt'), 'incompatible child change\n'));
  const before = await snapshot(f.dir);
  const resumed = await resumeIssue({ ...f.scope('F'), suspensionRef: parked.suspensionRef }, { directory: f.dir }, f.options);
  assert.equal(resumed.status, 'BLOCKED'); assert.deepEqual(await snapshot(f.dir), before);
  const saved = await readEvidence(f.dir, parked.suspensionRef);
  assert.equal(f.g('show', saved.suspension.sourceCommit + ':source.txt'), 'parent change');
  assert.equal(saved.attempt, 1); assert.match(f.g('stash', 'list'), /Pi issue suspension/);
});


test('interrupted parking and restore recover the same saved work without duplicate stash or attempt reset', integration, async t => {
  const f = await fixture(t); await f.approve('F'); await f.call('design-finish'); await f.call('start', { task_id: 'F' });
  const r = await f.run(await f.args('F'), 'NEEDS_DESIGN', () => writeFile(path.join(f.dir, 'new.txt'), 'saved untracked\n'));
  const interrupt = target => ({ ...f.options, interrupt: async stage => { if (stage === target) throw new Error('Simulated interruption ' + stage); } });
  const a = { ...f.scope('F'), previousAttempt: r.evidence.reference, reason: 'Design discovery' };
  const killed = await suspendIssue(a, { directory: f.dir }, interrupt('afterStash'));
  assert.equal(killed.status, 'BLOCKED'); assert.ok(killed.suspensionRef);
  assert.equal((await snapshot(f.dir)).clean, true);
  const parked = await suspendIssue({ ...a, suspensionRef: killed.suspensionRef }, { directory: f.dir }, f.options);
  assert.equal(parked.status, 'DESIGN', JSON.stringify(parked));
  assert.equal(f.g('stash', 'list', '--format=%H').split('\n').length, 1);
  await f.approve('F'); await f.call('design-finish');
  const b = { ...f.scope('F'), suspensionRef: parked.suspensionRef };
  const restored = await resumeIssue(b, { directory: f.dir }, interrupt('afterRestore'));
  assert.equal(restored.status, 'BLOCKED');
  assert.equal(await readFile(path.join(f.dir, 'new.txt'), 'utf8'), 'saved untracked\n');
  const unpinned = await resumeIssue(b, { directory: f.dir }, interrupt('afterHandoffRetention'));
  assert.equal(unpinned.status, 'BLOCKED'); assert.ok(unpinned.handoffRef, JSON.stringify(unpinned));
  const resumed = await resumeIssue({ ...b, handoffRef: unpinned.handoffRef }, { directory: f.dir }, f.options);
  assert.equal(resumed.status, 'READY', JSON.stringify(resumed)); assert.equal(resumed.consumedAttempts, 1);
  await f.call('start', { task_id: 'F' });
  const c = await f.finish('F', { ...resumed.resume, input: '{"operations":[]}' });
  assert.equal((await readEvidence(f.dir, c.evidenceRef)).attempt, 2);
});

test('phase and provenance checks cannot be bypassed by an unbound attempt or forged lifecycle handoff', integration, async t => {
  const f = await fixture(t);
  let called = false;
  const unbound = await executeAndReview({ baseRef: f.base, input: '{"operations":[]}', requirements: 'Bypass graph', buildCommand: ['build'], testCommand: ['test'] },
    { directory: f.dir }, { invokeConductor: async () => { called = true; throw new Error('must not run'); } });
  assert.equal(unbound.status, 'BLOCKED'); assert.equal(called, false);
  await f.approve('F'); await f.call('design-finish'); await f.call('start', { task_id: 'F' });
  const before = await snapshot(f.dir);
  const forged = await scaffoldTasks({ operation: 'design-reopen', feature_id: 'F', task_id: 'F', payload: { reason: 'Fake', reference: 'pi-evidence:sha256:' + 'a'.repeat(64) } },
    { directory: f.dir }, f.options.scaffoldOptions);
  assert.equal(forged.ok, false); assert.deepEqual(await snapshot(f.dir), before);
  assert.equal((await f.call('list')).feature.workflow.phase, 'implement');
  // A same-tree failure consumes budget even if a caller omits its receipt.
  const first = await f.run(await f.args('F'), 'NEEDS_DESIGN'); assert.equal(first.evidence.attempt, 1);
  const reset = await f.run(await f.args('F')); assert.equal(reset.status, 'BLOCKED');
});


test('final review findings return to the same graph and full feature validation includes issue contracts', integration, async t => {
  const f = await fixture(t); await f.approve('F'); await f.call('design-finish');
  await f.finish('F', null, () => writeFile(path.join(f.dir, 'result.txt'), 'initial implementation\n'));
  const root = (await f.call('list')).feature.tasks.F;
  const outside = await mkdtemp(path.join(tmpdir(), 'pi-issue-review-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const script = path.join(outside, 'review.cjs');
  async function reviewer(status) {
    await writeFile(script, `const fs=require('node:fs'); const args=process.argv.slice(2); const req=JSON.parse(fs.readFileSync(args[args.indexOf('--request')+1],'utf8')); const requirements=fs.readFileSync(req.requirements,'utf8'); if (!requirements.includes('Approved solution F')) process.exit(9); console.log(JSON.stringify({schema:'review.result/v1',status:${JSON.stringify(status)},reason:'REVIEW_COMPLETED',review_id:'issue-feature-review',completed_at:'2026-10-29T00:00:00Z',findings:${status === 'APPROVED' ? '[]' : "[{blocking:true,severity:'high',message:'Integration edge case missing'}]"}})); process.exit(${status === 'APPROVED' ? 0 : 1});`);
  }
  const validate = () => validateFeature({ featureId: 'F', designRef: f.binding('F').designRef,
    featureBaseRef: f.base, branch: 'feature/issues', headRef: f.g('rev-parse', 'HEAD'),
    buildCommand: [process.execPath, '-e', 'console.log("build passed")'],
    testCommand: [process.execPath, '-e', 'console.log("test result: ok. 3 passed; 0 failed")'],
    testSuccessPattern: '3 passed', review: { maxTurns: 3 } }, { directory: f.dir },
    { ...f.options, reviewOptions: { executable: process.execPath, prefixArgs: [script] } });
  await reviewer('CHANGES_REQUESTED');
  const failed = await validate(); assert.equal(failed.status, 'NEEDS_DESIGN', JSON.stringify(failed));
  await f.call('design-reopen', { payload: { reason: 'Integration review finding' } });
  await f.call('add', { payload: [{ id: 'review-fix', title: 'Integration correction', objective: 'Handle edge case',
    acceptance_criteria: ['Edge case handled'], dependencies: ['F'], context: 'Verification: regression',
    origin: { kind: 'review', reference: failed.evidenceRef } }] });
  await f.approve('review-fix'); await f.call('design-finish');
  await f.finish('review-fix', null, () => writeFile(path.join(f.dir, 'edge.txt'), 'edge case handled\n'));
  await reviewer('APPROVED');
  const passed = await validate(); assert.equal(passed.status, 'PASSED', JSON.stringify(passed));
  const feature = (await f.call('list')).feature;
  assert.equal(feature.validation.status, 'verified'); assert.deepEqual(feature.tasks.F, root);
  assert.deepEqual(feature.validation.history.filter(h => h.event === 'finished').map(h => h.result.status), ['NEEDS_DESIGN', 'PASSED']);
});


test('pending checkpoint authenticates the exact original subset index and rejects later staging changes', integration, async t => {
  for (const mutate of [false, true]) {
    const f = await fixture(t); await f.approve('F'); await f.call('design-finish');
    const failed = await f.finish('F', null, async () => {
      await writeFile(path.join(f.dir, 'source.txt'), 'verified staged\n'); f.g('add', 'source.txt');
      await writeFile(path.join(f.dir, 'other.txt'), 'verified unstaged\n');
    }, { interrupt: async stage => { if (stage === 'afterCommit') throw new Error('interrupted'); } });
    assert.equal(failed.ok, false);
    const head = f.g('rev-parse', 'HEAD');
    if (mutate) { f.g('read-tree', f.base); f.g('add', 'other.txt'); }
    const index = f.g('write-tree');
    const retried = await checkpointVerifiedTask({ ...f.scope('F'), evidenceRef: failed.evidenceRef, authorizationMode: 'manual' }, { directory: f.dir }, f.options);
    assert.equal(retried.ok, !mutate, JSON.stringify(retried));
    assert.equal(f.g('rev-parse', 'HEAD'), head);
    if (mutate) assert.equal(f.g('write-tree'), index);
    else assert.equal((await f.call('list')).feature.tasks.F.checkpoint.commit, head);
  }
});

test('started issue with no receipts returns to design without consuming an attempt', integration, async t => {
  const f = await fixture(t); await f.approve('F'); await f.call('design-finish'); await f.call('start', { task_id: 'F' });
  const parked = await suspendIssue({ ...f.scope('F'), reason: 'Precheck discovery before first attempt' }, { directory: f.dir }, f.options);
  assert.equal(parked.status, 'DESIGN', JSON.stringify(parked)); assert.equal(parked.consumedAttempts, 0);
  await f.approve('F'); await f.call('design-finish');
  const resumed = await resumeIssue({ ...f.scope('F'), suspensionRef: parked.suspensionRef }, { directory: f.dir }, f.options);
  assert.equal(resumed.status, 'READY', JSON.stringify(resumed)); assert.equal(resumed.consumedAttempts, 0);
  await f.call('start', { task_id: 'F' });
  const bypass = await f.run(await f.args('F')); assert.equal(bypass.status, 'BLOCKED');
  const c = await f.finish('F', { ...await f.args('F'), ...resumed.resume, input: '{"operations":[]}' });
  assert.equal((await readEvidence(f.dir, c.evidenceRef)).attempt, 1);
  const chain = await authenticateAttemptChain(f.dir, c.evidenceRef, f.binding('F'));
  assert.deepEqual(chain.records.map(r => r.attempt), [0, 1]);
});

test('suspended work resumes through a successor reconciliation after upstream rebase', integration, async t => {
  const f = await fixture(t); await f.add('F', ['pre', 'active']); await f.approve('F', true); await f.approve('pre'); await f.approve('active'); await f.call('design-finish');
  const checkpoint = await f.finish('pre', null, () => writeFile(path.join(f.dir, 'pre.txt'), 'prefix\n'));
  await f.call('start', { task_id: 'active' });
  const attempt = await f.run(await f.args('active'), 'NEEDS_DESIGN', () => writeFile(path.join(f.dir, 'source.txt'), 'suspended work\n'));
  const parked = await suspendIssue({ ...f.scope('active'), previousAttempt: attempt.evidence.reference, reason: 'Review design' }, { directory: f.dir }, f.options);
  assert.equal(parked.status, 'DESIGN', JSON.stringify(parked));
  await f.approve('active'); await f.call('design-finish');
  f.g('switch', 'main'); await writeFile(path.join(f.dir, 'upstream.txt'), 'upstream\n'); f.g('add', '.'); f.g('commit', '-qm', 'upstream'); const upstream = f.g('rev-parse', 'HEAD');
  f.g('switch', 'feature/issues'); f.g('rebase', '--onto', upstream, f.base);
  const outside = await mkdtemp(path.join(tmpdir(), 'issue-rebase-review-')); t.after(() => rm(outside, { recursive: true, force: true }));
  const script = path.join(outside, 'review.cjs'); await writeFile(script, `console.log(JSON.stringify({schema:'review.result/v1',status:'APPROVED',reason:'REVIEW_COMPLETED',review_id:'rebase',completed_at:'2026-10-29T00:00:00Z',findings:[]}));`);
  const anchor = await reconcileFeature({ ...f.scope('active'), featureId: 'F', designRef: f.binding('active').designRef,
    oldHeadRef: checkpoint.commit, upstreamBaseRef: upstream, headRef: f.g('rev-parse', 'HEAD'),
    buildCommand: [process.execPath, '-e', 'console.log("build passed")'], testCommand: [process.execPath, '-e', 'console.log("3 passed")'], testSuccessPattern: '3 passed' },
    { directory: f.dir }, { ...f.options, reviewOptions: { executable: process.execPath, prefixArgs: [script] } });
  assert.equal(anchor.status, 'PASSED', JSON.stringify(anchor));
  const resumed = await resumeIssue({ ...f.scope('active'), suspensionRef: parked.suspensionRef, reconciliationRef: anchor.evidenceRef }, { directory: f.dir }, f.options);
  assert.equal(resumed.status, 'READY', JSON.stringify(resumed));
  assert.equal(resumed.resume.reconciliationRef, anchor.evidenceRef);
  await f.call('start', { task_id: 'active' });
  const c = await f.finish('active', { ...resumed.resume, input: '{"operations":[]}' }, undefined, { reconciliationRef: anchor.evidenceRef });
  assert.equal((await readEvidence(f.dir, c.evidenceRef)).attempt, 2);
});


test('zero-attempt suspension rejects dirty source and hidden consumed attempts', integration, async t => {
  for (const receipt of [false, true]) {
    const f = await fixture(t); await f.approve('F'); await f.call('design-finish'); await f.call('start', { task_id: 'F' });
    if (receipt) await f.run(await f.args('F'), 'NEEDS_DESIGN');
    else await writeFile(path.join(f.dir, 'source.txt'), 'unretained edits\n');
    const before = await snapshot(f.dir);
    const r = await suspendIssue({ ...f.scope('F'), reason: 'Missing receipt' }, { directory: f.dir }, f.options);
    assert.equal(r.status, 'BLOCKED'); assert.deepEqual(await snapshot(f.dir), before);
    assert.equal((await f.call('list')).feature.workflow.phase, 'implement');
  }
});


test('scoped handoff survives fresh module load and detects graph, source and receipt changes', integration, async t => {
  const f = await fixture(t); await f.approve('F'); await f.call('design-finish');
  const args = { featureId: 'F', taskId: 'F', notes: { next_action: 'Inspect source then request execution approval', source_locations: ['source.txt'], open_questions: [] } };
  const before = await snapshot(f.dir), stateBefore = await readFile(path.join(f.dir, '.scaffold/tasks.json'), 'utf8');
  const saved = await prepareIssueHandoff(args, { directory: f.dir }, f.options);
  assert.equal(saved.ok, true, JSON.stringify(saved)); assert.equal(saved.applicable, true);
  assert.equal((await inspectIssueHandoff({ featureId: 'F', taskId: 'F' }, { directory: f.dir }, f.options)).reference, saved.reference);
  assert.equal(saved.handoff.attempt, null); assert.equal(saved.handoff.capsule.issue.design.summary, 'Approved solution F');
  assert.deepEqual(await snapshot(f.dir), before);
  assert.equal(await readFile(path.join(f.dir, '.scaffold/tasks.json'), 'utf8'), stateBefore);
  const fresh = await import('../pi/agent/extensions/conductor/issue-context.mjs?fresh');
  assert.equal((await fresh.inspectIssueHandoff({ reference: saved.reference }, { directory: f.dir }, f.options)).applicable, true);
  f.g('switch', '-qc', 'feature/other');
  assert.equal((await inspectIssueHandoff({ reference: saved.reference }, { directory: f.dir }, f.options)).applicable, false);
  f.g('switch', 'feature/issues');
  await writeFile(path.join(f.dir, 'source.txt'), 'changed\n');
  const stale = await inspectIssueHandoff({ reference: saved.reference }, { directory: f.dir }, f.options);
  assert.equal(stale.applicable, false); assert.equal(stale.handoff, undefined);
  await writeFile(path.join(f.dir, 'source.txt'), 'base\n');
  await f.call('start', { task_id: 'F' });
  assert.equal((await inspectIssueHandoff({ reference: saved.reference }, { directory: f.dir }, f.options)).applicable, false);
  const active = await prepareIssueHandoff(args, { directory: f.dir }, f.options);
  const failed = await f.run(await f.args('F'), 'NEEDS_DESIGN');
  assert.equal((await inspectIssueHandoff({ reference: active.reference }, { directory: f.dir }, f.options)).applicable, false);
  const updated = await prepareIssueHandoff(args, { directory: f.dir }, f.options);
  assert.equal(updated.applicable, true, JSON.stringify(updated));
  assert.equal(updated.handoff.attempt.consumed_attempts, 1);
  assert.match(updated.handoff.attempt.latest_findings[0].message, /Missing prerequisite/);
  const exact = await inspectIssueAttempt({ reference: failed.evidence.reference }, { directory: f.dir });
  assert.equal(exact.ok, true); assert.equal(exact.continuation.input, undefined);
  assert.equal(exact.continuation.requirements, (await f.args('F')).requirements);
  assert.equal(exact.matches_source, true);
  const dir = path.resolve(f.dir, f.g('rev-parse', '--git-path', 'pi-issue-context'));
  const file = path.join(dir, updated.reference.split(':').at(-1) + '.json');
  await writeFile(file, '{}');
  assert.equal((await inspectIssueHandoff({ reference: updated.reference }, { directory: f.dir }, f.options)).ok, false);
});

test('scoped selection matches internal full selection and mutation acknowledgements omit full graph', integration, async t => {
  const f = await fixture(t);
  assert.equal((await f.call('design-select')).context.issue.id, (await f.call('design-next')).task.id);
  assert.equal((await f.call('select')).context, null);
  await f.approve('F'); await f.call('design-finish');
  assert.equal((await f.call('select')).context.issue.id, (await f.call('next')).task.id);
  const { compactMutation } = await import('../pi/agent/extensions/scaffold/adapter.mjs');
  const result = await scaffoldTasks({ operation: 'start', feature_id: 'F', task_id: 'F' }, { directory: f.dir }, f.options.scaffoldOptions);
  assert.equal(compactMutation(result).data.status, 'in_progress');
  assert.equal(compactMutation(result).data.task, undefined);
  assert.equal(compactMutation(result).data.feature, undefined);
  const scope = await f.call('issue', { task_id: 'F' });
  assert.equal(scope.context.issue.history, undefined);
});

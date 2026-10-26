import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { git } from '../pi/agent/extensions/conductor/git-tree.mjs';
import { executeAndReview as executeTaskAttempt } from '../pi/agent/extensions/conductor/adapter.mjs';
import { readEvidence, retainEvidence, snapshot } from '../pi/agent/extensions/conductor/evidence.mjs';
import { checkpointVerifiedTask, checkpointAuthorization } from '../pi/agent/extensions/conductor/checkpoint.mjs';


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

async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'pi-checkpoint-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const g = (...args) => git(dir, args);
  g('init', '-q', '-b', 'main'); g('config', 'user.name', 'Test'); g('config', 'user.email', 'test@example.invalid');
  g('config', 'core.autocrlf', 'false');
  await writeFile(path.join(dir, 'value.txt'), 'before\n');
  await writeFile(path.join(dir, '.gitignore'), '.scaffold/\n');
  g('add', '.'); g('commit', '-qm', 'baseline'); g('switch', '-qc', 'feature/test');
  const base = g('rev-parse', 'HEAD');
  const feature = { id: 'F4', design_ref: 'approved@v1', tasks: {} };
  const options = { authorize: async () => true, scaffoldOptions: { invokeScaffold: async () => ({
    code: 0, stdout: JSON.stringify({ schema_version: 1, feature }), stderr: '',
  }) } };
  async function verify(id = 'one', baseRef = g('rev-parse', 'HEAD'), changes = async () => {
    await writeFile(path.join(dir, 'value.txt'), id + '\n');
  }) {
    const task = { featureId: 'F4', taskId: id, designRef: feature.design_ref };
    const args = { task, baseRef, requirements: id + ' criteria', input: '{"operations":[]}',
      buildCommand: ['fixture', 'build'], testCommand: ['fixture', 'test'] };
    const result = await executeAndReview(args, { directory: dir }, { invokeConductor: async json => {
      assert.equal(JSON.parse(json).review.base_ref, baseRef);
      await changes();
      return { code: 0, stderr: '', stdout: JSON.stringify({ schema: 'conductor.result/v1',
        status: 'PASSED', phase: 'review', execution: { success: true },
        checks: ['build', 'test'].map(name => ({ name, exit_code: 0, stdout: '2 checks passed' })), review: { status: 'APPROVED' } }) };
    } });
    assert.equal(result.status, 'PASSED', JSON.stringify(result));
    feature.tasks[id] = { id, feature_id: feature.id, status: 'completed', parent_id: null,
      dependencies: id === 'two' ? ['one'] : [], history: [{ to: 'completed', evidence: {
        feature_id: feature.id, task_id: id, result: 'PASSED', source: 'conductor', reference: result.evidence.reference,
      } }] };
    return { task, evidenceRef: result.evidence.reference, featureBaseRef: base,
      branch: 'feature/test', defaultBranch: 'main', protectedBranches: [], authorizationMode: 'manual' };
  }
  const checkpoint = (args, patch = {}) => checkpointVerifiedTask(args, { directory: dir }, { ...options, ...patch });
  return { dir, g, base, feature, options, verify, checkpoint };
}

test('two dependent tasks have separate verification baselines, commits, contents and durable recovery', async t => {
  const f = await fixture(t);
  const one = await f.verify();
  const first = await f.checkpoint(one);
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.baseRef, f.base); assert.equal(first.featureBaseRef, f.base);
  assert.equal(f.g('show', first.commit + ':value.txt'), 'one');
  assert.equal(f.g('status', '--porcelain'), '');
  const repeat = await f.checkpoint(one);
  assert.equal(repeat.commit, first.commit); assert.equal(repeat.recovered, true);
  const two = await f.verify('two', first.commit, async () => {
    await writeFile(path.join(f.dir, 'consumer.txt'), 'consumes one\n');
  });
  const receipt = await readEvidence(f.dir, two.evidenceRef);
  assert.equal(receipt.request.review.base_ref, first.commit);
  assert.equal(f.g('diff', '--name-only', first.commit), ''); // new consumer is untracked
  assert.equal(f.g('diff', '--name-only', first.commit, receipt.after.tree), 'consumer.txt');
  const second = await f.checkpoint(two);
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(second.baseRef, first.commit); assert.equal(second.featureBaseRef, f.base);
  assert.equal(f.g('diff', '--name-only', first.commit, second.commit), 'consumer.txt');
  assert.equal(f.g('diff', '--name-only', f.base, second.commit), 'consumer.txt\nvalue.txt');
  assert.match(f.g('show', '-s', '--format=%B', second.commit), /"taskId":"two"/);
  assert.equal((await f.checkpoint(two)).commit, second.commit);
  assert.equal(f.g('rev-list', '--count', f.base + '..HEAD'), '2');
});

test('missing, tampered, unsuccessful, mismatched and legacy receipts never commit', async t => {
  const f = await fixture(t); const args = await f.verify();
  const original = await readEvidence(f.dir, args.evidenceRef);
  for (const patch of [{ result: { status: 'BLOCKED' } }, { after: { ...original.after, tree: undefined } },
    { before: { ...original.before, clean: false } }, { request: { review: { base_ref: f.base, requirements: 'weakened' } } }]) {
    const evidenceRef = await retainEvidence(f.dir, { ...original, ...patch });
    f.feature.tasks.one.history[0].evidence.reference = evidenceRef;
    assert.equal((await f.checkpoint({ ...args, evidenceRef })).ok, false);
  }
  for (const patch of [{ evidenceRef: 'missing' }, { task: { ...args.task, taskId: 'other' } },
    { task: { ...args.task, designRef: 'other' } }]) assert.equal((await f.checkpoint({ ...args, ...patch })).ok, false);
  assert.equal(f.g('rev-parse', 'HEAD'), f.base);
});

test('changed source, unrelated unstaged/staged files and staged variants are preserved and rejected', async t => {
  for (const kind of ['source', 'unstaged', 'staged', 'divergentIndex']) {
    const f = await fixture(t);
    if (kind === 'divergentIndex') {
      const args = await f.verify('one', f.base, async () => {
        await writeFile(path.join(f.dir, 'value.txt'), 'unreviewed staged variant\n'); f.g('add', 'value.txt');
        await writeFile(path.join(f.dir, 'value.txt'), 'reviewed working variant\n');
      });
      const index = await readFile(path.join(f.dir, '.git/index'));
      assert.equal((await f.checkpoint(args)).ok, false);
      assert.deepEqual(await readFile(path.join(f.dir, '.git/index')), index);
    } else {
      const args = await f.verify();
      await writeFile(path.join(f.dir, kind === 'source' ? 'value.txt' : 'unrelated.txt'), 'unrelated\n');
      if (kind === 'staged') f.g('add', 'unrelated.txt');
      const index = await readFile(path.join(f.dir, '.git/index'));
      const status = f.g('status', '--porcelain');
      assert.equal((await f.checkpoint(args)).ok, false);
      assert.deepEqual(await readFile(path.join(f.dir, '.git/index')), index);
      assert.equal(f.g('status', '--porcelain'), status);
    }
    assert.equal(f.g('rev-parse', 'HEAD'), f.base);
  }
});

test('completed task, matching Scaffold evidence and ignored bookkeeping are mandatory', async t => {
  const f = await fixture(t); const args = await f.verify();
  f.feature.tasks.one.status = 'in_progress'; assert.equal((await f.checkpoint(args)).ok, false);
  f.feature.tasks.one.status = 'completed';
  f.feature.tasks.one.history[0].evidence.reference = 'wrong'; assert.equal((await f.checkpoint(args)).ok, false);
  f.feature.tasks.one.history[0].evidence.reference = args.evidenceRef;
  await mkdir(path.join(f.dir, '.scaffold')); await writeFile(path.join(f.dir, '.scaffold/tasks.json'), '{}');
  const result = await f.checkpoint(args); assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(f.g('ls-tree', '--name-only', result.commit, '--', '.scaffold'), '');
});

test('manual UI approval, feature-scoped grants and scope changes enforce authorization', async t => {
  let calls = 0, accept = false;
  const authorize = checkpointAuthorization(async () => { calls++; return accept; });
  const scope = { repository: 'repo', featureId: 'F4', branch: 'feature/test', designRef: 'v1', featureBaseRef: 'a' };
  assert.equal(await authorize(scope, 'manual'), false);
  accept = true;
  assert.equal(await authorize(scope, 'manual'), true); assert.equal(await authorize(scope, 'manual'), true); assert.equal(calls, 3);
  assert.equal(await authorize(scope, 'feature'), true); assert.equal(await authorize(scope, 'feature'), true); assert.equal(calls, 4);
  for (const key of Object.keys(scope)) await authorize({ ...scope, [key]: 'different' }, 'feature');
  assert.equal(calls, 9);
  const fresh = checkpointAuthorization(async () => false); assert.equal(await fresh(scope, 'feature'), false);
  const f = await fixture(t); const args = await f.verify();
  assert.equal((await f.checkpoint(args, { authorize: undefined })).ok, false);
  assert.equal((await f.checkpoint(args, { authorize: async () => false })).ok, false);
  assert.equal(f.g('rev-parse', 'HEAD'), f.base);
});

test('protected/default/known branches, detached HEAD and mismatched branch cannot commit', async t => {
  const f = await fixture(t); const args = await f.verify();
  for (const patch of [{ defaultBranch: args.branch }, { protectedBranches: [args.branch] }, { branch: 'other' }])
    assert.equal((await f.checkpoint({ ...args, ...patch })).ok, false);
  f.g('branch', '-m', 'master'); assert.equal((await f.checkpoint({ ...args, branch: 'master' })).ok, false);
  f.g('checkout', '--detach', '-q'); assert.equal((await f.checkpoint(args)).ok, false);
  assert.equal(f.g('rev-parse', 'HEAD'), f.base);
});

test('interruption before commit and after ref update recovers without duplicate commits or lost index', async t => {
  for (const point of ['beforeCommit', 'afterStaging', 'afterCommit']) {
    const f = await fixture(t); const args = await f.verify();
    const result = await f.checkpoint(args, { interrupt: async stage => { if (stage === point) throw new Error('interrupted'); } });
    assert.equal(result.ok, false);
    const fresh = await import('../pi/agent/extensions/conductor/checkpoint.mjs?new-session');
    const recovered = await fresh.checkpointVerifiedTask(args, { directory: f.dir }, f.options);
    assert.equal(recovered.ok, true, JSON.stringify(recovered));
    assert.equal(recovered.recovered, point === 'afterCommit');
    assert.equal(f.g('rev-list', '--count', f.base + '..HEAD'), '1');
    assert.equal(f.g('status', '--porcelain'), '');
  }
});

test('Git failures, existing locks, HEAD drift, authorization-time edits and feature lineage fail closed', async t => {
  for (const kind of ['lock', 'head', 'identity', 'race', 'featureBaseline']) {
    const f = await fixture(t); const args = await f.verify();
    if (kind === 'lock') await writeFile(path.join(f.dir, '.git/index.lock'), 'belongs to someone else');
    if (kind === 'head') f.g('commit', '--allow-empty', '-qm', 'unexpected');
    if (kind === 'identity') {
      for (const name of ['GIT_AUTHOR_NAME', 'GIT_COMMITTER_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_EMAIL']) {
        const old = process.env[name]; delete process.env[name];
        t.after(() => { if (old !== undefined) process.env[name] = old; });
      } f.g('config', 'user.useConfigOnly', 'true'); f.g('config', 'user.name', ''); f.g('config', 'user.email', ''); }
    const result = await f.checkpoint(kind === 'featureBaseline' ? { ...args, featureBaseRef: 'a'.repeat(40) } : args,
      kind === 'race' ? { authorize: async () => { await writeFile(path.join(f.dir, 'value.txt'), 'raced\n'); return true; } } : {});
    assert.equal(result.ok, false, kind);
    if (kind === 'lock') assert.equal(await readFile(path.join(f.dir, '.git/index.lock'), 'utf8'), 'belongs to someone else');
    if (kind !== 'head') assert.equal(f.g('rev-parse', 'HEAD'), f.base);
  }
});

test('deletions, binary files, spaces and unchanged parent verification use exact Git trees', async t => {
  const f = await fixture(t);
  const args = await f.verify('one', f.base, async () => {
    await rm(path.join(f.dir, 'value.txt'));
    await writeFile(path.join(f.dir, 'binary file.bin'), Buffer.from([0, 255, 13, 10]));
  });
  const result = await f.checkpoint(args); assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(execFileSync('git', ['-C', f.dir, 'show', result.commit + ':binary file.bin']), Buffer.from([0, 255, 13, 10]));
  assert.equal(f.g('ls-tree', '--name-only', result.commit, '--', 'value.txt'), '');
  const parent = await f.verify('parent', result.commit, async () => {});
  const checked = await f.checkpoint(parent); assert.equal(checked.ok, true, JSON.stringify(checked));
  assert.equal(f.g('diff', '--name-only', result.commit, checked.commit), '');
});


test('a staged reversal after a finished checkpoint is preserved, never treated as interrupted staging', async t => {
  const f = await fixture(t); const args = await f.verify();
  const first = await f.checkpoint(args); assert.equal(first.ok, true);
  f.g('read-tree', f.base);
  const index = await readFile(path.join(f.dir, '.git/index'));
  const recovered = await f.checkpoint(args);
  assert.equal(recovered.ok, false);
  assert.deepEqual(await readFile(path.join(f.dir, '.git/index')), index);
  assert.equal(f.g('rev-parse', 'HEAD'), first.commit);
});

test('session reset revokes feature grants and pending approval; cancellation cannot commit', async t => {
  let reply, calls = 0;
  const authorize = checkpointAuthorization(async () => { calls++; return true; });
  const scope = { featureId: 'F4', branch: 'feature/test' };
  await authorize(scope, 'feature'); authorize.reset(); await authorize(scope, 'feature'); assert.equal(calls, 2);
  const pending = checkpointAuthorization(() => new Promise(resolve => { reply = resolve; }));
  const request = pending(scope, 'feature'); pending.reset(); reply(true);
  assert.equal(await request, false);
  const f = await fixture(t); const args = await f.verify();
  const controller = new AbortController();
  const result = await checkpointVerifiedTask(args, { directory: f.dir, abort: controller.signal }, {
    ...f.options, authorize: async () => { controller.abort(); return true; },
  });
  assert.equal(result.ok, false); assert.equal(f.g('rev-parse', 'HEAD'), f.base);
});

test('merge/rebase ambiguity, tracked Scaffold, hidden index entries and lost receipt bytes fail closed', async t => {
  for (const kind of ['merge', 'rebase', 'scaffold', 'hidden', 'tampered']) {
    const f = await fixture(t); const args = await f.verify();
    if (kind === 'merge') await writeFile(path.join(f.dir, '.git/MERGE_HEAD'), f.base + '\n');
    if (kind === 'rebase') await mkdir(path.join(f.dir, '.git/rebase-merge'));
    if (kind === 'scaffold') {
      await mkdir(path.join(f.dir, '.scaffold')); await writeFile(path.join(f.dir, '.scaffold/tasks.json'), '{}');
      f.g('add', '-f', '.scaffold/tasks.json');
    }
    if (kind === 'hidden') f.g('update-index', '--assume-unchanged', 'value.txt');
    if (kind === 'tampered') {
      await writeFile(path.join(f.dir, '.git/pi-conductor-evidence', args.evidenceRef.split(':').at(-1) + '.json'), '{}');
    }
    assert.equal((await f.checkpoint(args)).ok, false, kind);
    assert.equal(f.g('rev-parse', 'HEAD'), f.base);
  }
});


test('a fully staged verified tree is supported without absorbing unrelated index content', async t => {
  const f = await fixture(t);
  const args = await f.verify('one', f.base, async () => {
    await writeFile(path.join(f.dir, 'value.txt'), 'verified staged content\n');
    f.g('add', 'value.txt');
  });
  const result = await f.checkpoint(args);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(f.g('show', result.commit + ':value.txt'), 'verified staged content');
  assert.equal(f.g('status', '--porcelain'), '');
});

test('real test wrapper preserves command output/status and binds the pre-review source snapshot', async t => {
  for (const mode of ['stable', 'sourceDrift', 'indexDrift', 'missingBoundary', 'testFailure']) {
    const f = await fixture(t);
    const command = [process.execPath, '-e', mode === 'testFailure' ? 'process.exit(7)' : 'console.log("2 relevant tests passed")'];
    const args = { task: { featureId: 'F4', taskId: 'one', designRef: 'approved@v1' }, baseRef: f.base,
      requirements: 'One behavior', input: '{"operations":[]}', buildCommand: ['fixture', 'build'], testCommand: command };
    const result = await executeTaskAttempt(args, { directory: f.dir }, { invokeConductor: async json => {
      const req = JSON.parse(json);
      await writeFile(path.join(f.dir, 'value.txt'), 'tested and reviewed\n');
      const test = req.checks.find(c => c.name === 'test');
      const boundary = JSON.parse(test.args[1]);
      assert.deepEqual(boundary.command, command);
      let code = 0;
      if (mode !== 'missingBoundary') {
        try { assert.match(execFileSync(test.program, test.args, { encoding: 'utf8' }), /2 relevant tests passed/); }
        catch (error) { if (mode !== 'testFailure') throw error; code = error.status; }
      }
      if (mode === 'sourceDrift') await writeFile(path.join(f.dir, 'value.txt'), 'changed during review\n');
      if (mode === 'indexDrift') f.g('add', 'value.txt');
      return { code: code === 0 ? 0 : 2, stdout: JSON.stringify({ schema: 'conductor.result/v1',
        status: code === 0 ? 'PASSED' : 'NEEDS_DESIGN', phase: code === 0 ? 'review' : 'verification', execution: { success: true },
        checks: [{ name: 'build', exit_code: 0 }, { name: 'test', exit_code: code }], review: { status: 'APPROVED' } }) };
    } });
    assert.equal(result.status, mode === 'stable' ? 'PASSED' : mode === 'testFailure' ? 'NEEDS_DESIGN' : 'BLOCKED', JSON.stringify(result));
    if (result.status === 'BLOCKED') assert.equal(result.reason, 'REVIEW_SNAPSHOT_CHANGED');
    const receipt = await readEvidence(f.dir, result.evidence.reference);
    assert.deepEqual(receipt.args.testCommand, command);
    if (mode === 'stable') assert.equal(receipt.reviewSnapshot.digest, receipt.after.digest);
  }
});

test('real Scaffold handoff: complete/checkpoint two dependent tasks and isolate second review', {
  skip: !process.env.SCAFFOLD_SOURCE || process.platform === 'win32' ? 'Set SCAFFOLD_SOURCE for real Python CLI integration' : false,
}, async t => {
  const { scaffoldTasks } = await import('../pi/agent/extensions/scaffold/adapter.mjs');
  const f = await fixture(t);
  f.options.scaffoldOptions = { invokeScaffold: async (_program, args, ctx) => {
    try {
      const stdout = execFileSync('python3', ['-c', 'import sys;sys.path.insert(0, sys.argv.pop(1));from scaffold_cli.cli import main;main()',
        path.join(process.env.SCAFFOLD_SOURCE, 'src'), ...args], { cwd: ctx.cwd, input: ctx.input, encoding: 'utf8' });
      return { code: 0, stdout, stderr: '' };
    } catch (error) { return { code: error.status, stdout: error.stdout, stderr: error.stderr }; }
  } };
  const call = async (operation, extra = {}) => {
    const result = await scaffoldTasks({ operation, feature_id: 'F4', ...extra }, { directory: f.dir }, f.options.scaffoldOptions);
    assert.equal(result.ok, true, JSON.stringify(result)); return result.data;
  };
  await call('init', { payload: { id: 'F4', title: 'Feature', objective: 'Two independent review scopes',
    design_ref: 'approved@v1', context: 'Feature baseline ' + f.base, acceptance_criteria: ['Dependent consumer works'] } });
  await call('add', { payload: ['one', 'two'].map(id => ({ id, title: id, objective: id,
    acceptance_criteria: [id + ' verified'], dependencies: id === 'two' ? ['one'] : [] })) });
  let last = f.base;
  for (const id of ['one', 'two']) {
    assert.equal((await call('next')).task.id, id);
    await call('start', { task_id: id });
    const args = await f.verify(id, last, async () => { await writeFile(path.join(f.dir, id + '.txt'), id); });
    await call('complete', { task_id: id, payload: { feature_id: 'F4', task_id: id, result: 'PASSED',
      source: 'conductor', reference: args.evidenceRef, summary: 'Deterministic build/test/review fixture passed' } });
    const checkpoint = await f.checkpoint(args);
    assert.equal(checkpoint.ok, true, JSON.stringify(checkpoint));
    assert.equal(f.g('diff', '--name-only', last, checkpoint.commit), id + '.txt');
    assert.equal((await readEvidence(f.dir, args.evidenceRef)).request.review.base_ref, last);
    last = checkpoint.commit;
  }
  assert.equal((await call('next')).task, null);
  assert.equal(f.g('rev-list', '--count', f.base + '..HEAD'), '2');
});

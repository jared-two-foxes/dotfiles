import { createHash } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, readdir, mkdir, rm, chmod, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldTasks, checkStatePaths, buildCommand, OPERATIONS } from '../pi/agent/extensions/scaffold/adapter.mjs';

const root = path.resolve(import.meta.dirname, '..');
const context = 'Approved feature context';
const feature = { context, id: 'F1', title: 'Feature', objective: 'Deliver feature', design_ref: 'sha256:' + createHash('sha256').update(context).digest('hex'), acceptance_criteria: ['Feature works'], baseline: 'a'.repeat(40), branch: 'feature/test' };
const definition = (id = 'T1') => ({ id, title: id, objective: 'Deliver task', acceptance_criteria: ['Task works'] });
const task = (id = 'T1', status = 'pending') => ({ ...definition(id), feature_id: 'F1', parent_id: null, status, dependencies: [], history: [] });
const evidence = { feature_id: 'F1', task_id: 'T1', result: 'PASSED', source: 'conductor', reference: 'retained-result-1', summary: 'Verified criteria' };
const params = operation => ({ operation, feature_id: 'F1',
  ...(['issue', 'start', 'complete', 'block', 'fail', 'retry', 'decompose', 'design-record', 'checkpoint-record', 'issue-resume', 'delivery-record', 'attempt-record'].includes(operation) ? { task_id: 'T1' } : {}),
  ...(['block', 'fail', 'retry'].includes(operation) ? { reason: 'Explicit decision' } : {}),
  ...({ init: { payload: feature }, add: { payload: [definition()] }, complete: { payload: evidence }, decompose: { payload: [definition('child')] },
    'design-record': { payload: { summary: 'Approved', verification: 'Tests', approval: 'User confirmed', disposition: 'leaf' } },
    'design-reopen': { payload: { reason: 'Review finding' } },
    'checkpoint-record': { payload: { commit: 'a'.repeat(40), parent: 'b'.repeat(40), tree: 'c'.repeat(40), reference: 'sha256:' + 'd'.repeat(64) } },
    'delivery-record': { payload: { expected_revision: 0, event: { kind: 'initialized', context: {}, head: null, sequence: 0 } } },
    'direction-approve': { payload: { scope_digest: 'd'.repeat(64), capabilities: ['design'] } },
    'attempt-record': { payload: { attempt: 1, status: 'PASSED', receipt: 'sha256:' + 'a'.repeat(64), base: 'a'.repeat(40), tree: 'b'.repeat(40) } },
    'history-foreign': { payload: { from: 'a'.repeat(40), to: 'b'.repeat(40), source: 'user-commits', approval: 'sha256:' + 'c'.repeat(64), commits: [{ commit: 'b'.repeat(40), parents: ['a'.repeat(40)], subject: 'user' }] } },
    'history-rewrite': { payload: { old_head: 'a'.repeat(40), new_head: 'b'.repeat(40), new_base: 'c'.repeat(40), history: [], verification: 'sha256:' + 'c'.repeat(64) } },
    'failure-record': { payload: { code: 'CHECK_FAILED', message: 'The test check failed', tool: 'execute_and_review', owner: 'agent', next: ['Fix the test'] } },
    'artifact-put': { payload: { receipt: 1 } },
    'artifact-get': { payload: { reference: 'sha256:' + 'c'.repeat(64) } },
    'issue-resume': { payload: { reference: 'sha256:' + 'e'.repeat(64), handoff: 'sha256:' + 'f'.repeat(64) } } }[operation] ?? {}),
});
const success = data => ({ code: 0, stdout: JSON.stringify({ schema_version: 3, ...data, ...(data.feature ? {feature:{...data.feature,original_baseline:data.feature.baseline,direction_scope:'d'.repeat(64),head:data.feature.baseline,base:data.feature.baseline,history:[],workflow:{kind:'recursive-issues/v1',phase:'implement',root_id:'T1'}}} : {}) }), stderr: '' });
function response(operation) {
  if (operation === 'artifact-put') return { code: 0, stdout: JSON.stringify({ schema_version: 3, reference: 'sha256:' + 'c'.repeat(64) }), stderr: '' };
  if (operation === 'artifact-get') return { code: 0, stdout: JSON.stringify({ schema_version: 3, artifact: { receipt: 1 } }), stderr: '' };
  if (['summary', 'issue', 'select', 'design-select'].includes(operation)) {
    const summary = { id: 'F1', design_ref: feature.design_ref, phase: 'implement', task_revision: 1, state_digest: 'a'.repeat(64), counts: { pending: 1 }, baseline: feature.baseline, branch: feature.branch };
    return success({ summary, ...(operation === 'summary' ? {} : { context: { schema: 'scaffold.issue-context/v1', feature: summary, issue: { ...task(), constraints: [] }, ancestors: [], prerequisites: [], children: [] } }) });
  }
  if (['start', 'complete', 'block', 'fail', 'retry'].includes(operation)) {
    return success({ task: task('T1', { start: 'in_progress', complete: 'completed', block: 'blocked', fail: 'failed', retry: 'pending' }[operation]) });
  }
  return success({ feature: { ...feature, tasks: { T1: task() } } });
}
async function fixture(t) {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'pi-scaffold-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', dir]);
  await writeFile(path.join(dir, 'application.txt'), 'unchanged');
  return dir;
}

test('every operation constructs one exact CLI invocation and JSON stdin', async t => {
  const dir = await fixture(t);
  const subdirectory = path.join(dir, 'src');
  await mkdir(subdirectory);
  for (const operation of OPERATIONS) {
    let calls = 0;
    const request = params(operation);
    const result = await scaffoldTasks(request, { directory: subdirectory }, {
      authorizeIssueMutation: async () => {},
      invokeScaffold: async (program, args, options) => {
        // Guarded operations first read the feature through the CLI (Pi never reads Scaffold files).
        if (args[0] === 'list' && operation !== 'list') return response('list');
        calls++;
        assert.equal(program, 'scaffold');
        const expected = [operation, '--feature=F1'];
        if (request.task_id) expected.push('--task=T1');
        if (request.reason) expected.push('--reason=Explicit decision');
        if (request.payload) expected.push('--input', '-');
        assert.deepEqual(args, expected);
        assert.equal(options.cwd, dir);
        assert.equal(options.input, request.payload ? JSON.stringify(request.payload) : '');
        return response(operation);
      },
    });
    assert.equal(calls, 1);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.feature_id, 'F1');
    assert.equal(result.task_id, request.task_id);
    assert.deepEqual(result.data, JSON.parse(response(operation).stdout));
  }
  assert.equal(await readFile(path.join(dir, 'application.txt'), 'utf8'), 'unchanged');
});

test('payloads and free-text arguments are literal, not shell interpolation', () => {
  const payload = { ...feature, context: 'Quotes " and newline\n$(touch unsafe); `command`' };
  payload.design_ref = 'sha256:' + createHash('sha256').update(payload.context).digest('hex');
  const built = buildCommand({ ...params('init'), payload });
  assert.equal(built.input, JSON.stringify(payload));
  assert.deepEqual(JSON.parse(built.input), payload);
  assert.deepEqual(buildCommand({ ...params('list'), feature_id: '-literal' }).args, ['list', '--feature=-literal']);
  assert.deepEqual(buildCommand({ ...params('block'), reason: '--literal; $(x)' }).args.slice(-1), ['--reason=--literal; $(x)']);
});

test('required, extraneous and invalid arguments fail before invoking Scaffold', async t => {
  const dir = await fixture(t);
  const bad = [undefined, {}, { operation: 'push-ticket', feature_id: 'F1' }, { operation: 'clean', feature_id: 'F1' }, { operation: 'next', feature_id: 'F1' }, { operation: 'design-next', feature_id: 'F1' },
    { ...params('list'), repo_path: '../elsewhere' },
    { ...params('start'), task_id: '' },
    { ...params('list'), task_id: 'T1' }, { ...params('list'), payload: {} },
    { ...params('list'), reason: 'oops' }, { ...params('block'), reason: ' ' },
    { ...params('init'), payload: undefined }, { ...params('add'), payload: [] },
    { ...params('init'), payload: { ...feature, id: 'wrong' } },
    { ...params('init'), payload: { ...feature, design_ref: '' } },
    { ...params('add'), payload: [{ ...definition(), dependencies: ['T2', 'T2'] }] },
    { ...params('add'), payload: [{ ...definition(), status: 'completed' }] },
    { ...params('complete'), payload: { ...evidence, task_id: 'other' } },
    { ...params('complete'), payload: { ...evidence, feature_id: 'other' } },
    { ...params('complete'), payload: { ...evidence, result: 'BLOCKED' } },
    { ...params('complete'), payload: { ...evidence, reference: '' } },
  ];
  for (const request of bad) {
    const result = await scaffoldTasks(request, { directory: dir }, { invokeScaffold: () => assert.fail('must not invoke') });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'INVALID_ARGUMENTS');
  }
});

test('nonzero exits retain structured stderr and never retry or complete', async t => {
  const dir = await fixture(t);
  for (const failure of [
    { code: 1, stdout: '', stderr: '{"schema_version":1,"error":"Unknown feature"}' },
    { code: 2, stdout: '', stderr: 'usage: scaffold summary ...' },
    { code: null, stdout: '', stderr: 'terminated' },
  ]) {
    let calls = 0;
    const result = await scaffoldTasks(params('start'), { directory: dir }, {
      invokeScaffold: async () => { calls++; return failure; },
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'COMMAND_FAILED');
    assert.equal(result.exit_code, failure.code);
    assert.equal(result.stderr, failure.stderr);
    if (failure.code === 1) assert.equal(result.scaffold_error.error, 'Unknown feature');
    assert.equal(calls, 1);
  }
});

test('malformed, unsupported, mismatched and incomplete responses fail safely', async t => {
  const dir = await fixture(t);
  const base = JSON.parse(response('select').stdout);
  const invalid = ['not json', 'null', '[]', '{}',
    JSON.stringify({ ...base, schema_version: 2 }),
    JSON.stringify({ ...base, schema_version: 1 }),
    JSON.stringify({ ...base, schema_version: '1' }),
    JSON.stringify({ ...base, error: 'failure' }),
    JSON.stringify({ ...base, summary: { ...base.summary, id: 'other' } }),
    JSON.stringify({ ...base, context: undefined }),
    JSON.stringify({ ...base, context: { ...base.context, issue: { ...task(), feature_id: 'other' } } }),
    JSON.stringify({ ...base, context: { ...base.context, issue: { ...task(), status: 'invented' } } }),
  ];
  for (const stdout of invalid) {
    const result = await scaffoldTasks(params('select'), { directory: dir }, {
      invokeScaffold: async () => ({ code: 0, stdout, stderr: '' }),
    });
    assert.equal(result.ok, false, stdout);
    assert.match(result.reason, /INVALID_JSON|INVALID_RESPONSE/);
  }
  for (const returnedTask of [task('wrong', 'completed'), task('T1', 'pending')]) {
    const result = await scaffoldTasks(params('complete'), { directory: dir }, {
      invokeScaffold: async () => success({ task: returnedTask }),
    });
    assert.equal(result.reason, 'INVALID_RESPONSE');
  }
  const empty = await scaffoldTasks(params('select'), { directory: dir }, {
    invokeScaffold: async () => success({ summary: base.summary, context: null }),
  });
  assert.equal(empty.ok, true);
  assert.equal(empty.data.context, null);
});

test('missing executable, cancellation and subprocess exceptions are structured failures', async t => {
  const dir = await fixture(t);
  for (const code of ['ENOENT', 'ABORT_ERR', 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER']) {
    const result = await scaffoldTasks(params('list'), { directory: dir }, {
      invokeScaffold: async () => { throw Object.assign(new Error(code), { code }); },
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, code === 'ENOENT' ? 'EXECUTABLE_NOT_FOUND' : 'EXECUTION_ERROR');
  }
  const abort = new AbortController(); abort.abort();
  const cancelled = await scaffoldTasks(params('list'), { directory: dir, abort: abort.signal });
  assert.equal(cancelled.ok, false);
});

test('requires a current repository and refuses task-state symlinks', async t => {
  const dir = await fixture(t);
  const outside = await mkdtemp(path.join(tmpdir(), 'pi-scaffold-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  for (const directory of [undefined, outside]) {
    const result = await scaffoldTasks(params('list'), { directory }, { invokeScaffold: () => assert.fail('must not invoke') });
    assert.equal(result.ok, false);
  }
  if (process.platform === 'win32') return; // symlink privileges vary on Windows
  for (const suffix of ['.scaffold', '.scaffold/features', '.scaffold/.tasks.lock']) {
    if (suffix !== '.scaffold') await mkdir(path.join(dir, '.scaffold'), { recursive: true });
    const target = path.join(dir, suffix);
    await symlink(outside, target);
    const result = await scaffoldTasks(params('init'), { directory: dir }, { invokeScaffold: () => assert.fail('must not follow symlink') });
    assert.equal(result.ok, false);
    assert.match(result.message, /symlinks/);
    assert.ok(result.message.includes(suffix));
    await assert.rejects(checkStatePaths(dir), /symlinks/);
    await rm(target);
  }
});

test('task-state preflight rejects non-directory state and non-file lock or JSON', async t => {
  for (const [suffix, expected] of [
    ['.scaffold', /must be a directory/],
    ['.scaffold/features', /must be a directory/],
    ['.scaffold/.tasks.lock', /must be a regular file/],
  ]) {
    const dir = await fixture(t);
    const target = path.join(dir, suffix);
    if (suffix === '.scaffold' || suffix === '.scaffold/features') {
      if (suffix !== '.scaffold') await mkdir(path.join(dir, '.scaffold'));
      await writeFile(target, 'not a directory');
    } else {
      await mkdir(path.join(dir, '.scaffold'));
      await mkdir(target);
    }
    const result = await scaffoldTasks(params('init'), { directory: dir }, {
      invokeScaffold: () => assert.fail('must not invoke Scaffold on invalid state paths'),
    });
    assert.equal(result.ok, false, suffix);
    assert.match(result.message, expected);
    await assert.rejects(checkStatePaths(dir), expected);
  }
});

test('regular ledger directory and lock file allow safe CLI access', async t => {
  const dir = await fixture(t);
  await mkdir(path.join(dir, '.scaffold', 'features'), { recursive: true });
  await writeFile(path.join(dir, '.scaffold', '.tasks.lock'), '0');

  let commands = 0;
  const result = await scaffoldTasks(params('list'), { directory: dir }, {
    invokeScaffold: async (_program, args) => {
      commands++;
      assert.equal(args[0], 'list');
      return response('list');
    },
  });
  assert.equal(result.ok, true);
  assert.equal(commands, 1);
  await checkStatePaths(dir);
  assert.equal(await readFile(path.join(dir, '.scaffold', '.tasks.lock'), 'utf8'), '0');
});

test('clean is not an agent operation', () => {
  // Old receipts can no longer attach to a fresh instance: each instance has its own ledger directory.
  assert.equal(OPERATIONS.includes('clean'), false);
  assert.throws(() => buildCommand({operation:'clean',feature_id:'F1'}), /Unsupported|operation/i);
});

test('production adapter only invokes Git inspection and scaffold tasks, with no file writes', async () => {
  // The process runner lives in lib/scaffold/process.mjs so shared modules can reach Scaffold.
  const adapter = await readFile(path.join(root, 'pi/agent/extensions/scaffold/adapter.mjs'), 'utf8') +
    await readFile(path.join(root, 'pi/agent/lib/scaffold/process.mjs'), 'utf8');
  const extension = await readFile(path.join(root, 'pi/agent/extensions/scaffold/index.ts'), 'utf8');
  assert.doesNotMatch(adapter, /writeFile|mkdir|unlink|rename|executeAndReview|invokeConductor|push-ticket|next-step/i);
  assert.match(adapter, /shell: false/);
  assert.match(adapter, /child\.stdin\.end\(input\)/);
  assert.match(extension, /name: "scaffold_tasks"/);
  assert.match(extension, /directory: ctx.cwd, abort: signal/);
  assert.match(extension, /isError: !result.ok/);
  assert.doesNotMatch(extension, /scaffold_run|executeAndReview|execute_and_review/);
});

// Opt-in reproducible test against an unmodified checkout of Scaffold Phase 1.
// The launcher uses the real console-entry-point dispatcher, not a mock state store.
test('real Scaffold CLI lifecycle persists dependent tasks and resumes in a new adapter session', {
  skip: !process.env.SCAFFOLD_SOURCE || process.platform === 'win32' ? 'Set SCAFFOLD_SOURCE to a Phase 1 checkout (POSIX launcher)' : false,
}, async t => {
  const dir = await fixture(t);
  const bin = await mkdtemp(path.join(tmpdir(), 'scaffold-cli-bin-'));
  t.after(() => rm(bin, { recursive: true, force: true }));
  const source = path.resolve(process.env.SCAFFOLD_SOURCE, 'src');
  await writeFile(path.join(bin, 'scaffold'), '#!/usr/bin/env python3\nimport sys\nsys.path.insert(0, ' + JSON.stringify(source) + ')\nfrom scaffold_cli.cli import main\nmain()\n');
  await chmod(path.join(bin, 'scaffold'), 0o755);
  const previous = process.env.PATH;
  process.env.PATH = bin + path.delimiter + previous;
  t.after(() => { process.env.PATH = previous; });
  const call = async request => {
    const result = await scaffoldTasks(request, { directory: dir });
    assert.equal(result.ok, true, JSON.stringify(result));
    return result.data;
  };
  await call(params('init'));
  await call({ ...params('add'), operation:'decompose', task_id:'F1', payload: [definition(), { ...definition('T2'), dependencies: ['T1'] }] });
  assert.equal((await call(params('select'))).context, null);
  for (const task_id of ['F1','T1','T2']) await call({operation:'design-record',feature_id:'F1',task_id,payload:{summary:'Approved', verification:'Checks', approval:'User confirmed', disposition:task_id === 'F1' ? 'decomposed' : 'leaf'}});
  await call({operation:'design-finish',feature_id:'F1'});
  assert.equal((await call(params('select'))).context.issue.id, 'T1');
  const scope = (await call(params('list'))).feature.direction_scope;
  const refused = await scaffoldTasks(params('start'), { directory: dir });
  assert.equal(refused.ok, false);
  assert.match(refused.scaffold_error.error, /Approve the feature direction/);
  await call({ operation: 'direction-approve', feature_id: 'F1', payload: { scope_digest: scope } });
  await call(params('start'));
  // Fresh module instance, no previous conversation or adapter memory.
  const fresh = await import('../pi/agent/extensions/scaffold/adapter.mjs?new-session');
  const resumed = await fresh.scaffoldTasks(params('list'), { directory: dir });
  assert.equal(resumed.ok, true);
  assert.equal(resumed.data.feature.tasks.T1.status, 'in_progress');
  assert.equal(resumed.data.feature.tasks.T2.dependencies[0], 'T1');
  assert.equal((await call(params('select'))).context, null);
  const premature = await scaffoldTasks({ ...params('start'), task_id: 'T2' }, { directory: dir });
  assert.equal(premature.ok, false);
  const receipt = (await call({ operation: 'artifact-put', feature_id: 'F1', payload: { receipt: 'T1' } })).reference;
  const unrecorded = await scaffoldTasks({ ...params('complete'), payload: { ...evidence, reference: receipt } }, { directory: dir });
  assert.equal(unrecorded.ok, false); // completion must cite a recorded PASSED attempt
  assert.match(unrecorded.scaffold_error.error, /recorded PASSED attempt/);
  await call({ operation: 'attempt-record', feature_id: 'F1', task_id: 'T1',
    payload: { attempt: 1, status: 'PASSED', receipt, base: 'a'.repeat(40), tree: 'b'.repeat(40) } });
  const passed = { ...evidence, reference: receipt };
  await call({ ...params('complete'), payload: passed });
  const listed = await call(params('list'));
  assert.deepEqual(listed.feature.tasks.T1.history.at(-1).evidence, passed);
  assert.equal((await call(params('select'))).context, null); // missing checkpoint blocks every next issue
  const blocked = await scaffoldTasks({...params('start'),task_id:'T2'}, {directory:dir});
  assert.equal(blocked.ok, false); assert.match(blocked.scaffold_error.error, /checkpoint/);
  assert.equal(await readFile(path.join(dir,'application.txt'),'utf8'), 'unchanged');
});

test('real Scaffold clean invalidates old feature state and reinit changes identity', {
  skip: !process.env.SCAFFOLD_SOURCE || process.platform === 'win32'
    ? 'Requires POSIX Python Scaffold checkout' : false,
}, async t => {
  const dir = await fixture(t);
  const source = path.resolve(process.env.SCAFFOLD_SOURCE, 'src');
  const script = "import sys;sys.path.insert(0,sys.argv.pop(1));from scaffold_cli.cli import main;main()";
  const { invoke } = await import('../pi/agent/extensions/scaffold/adapter.mjs');
  const invokeScaffold = (_program, args, options) =>
    invoke('python3', ['-c', script, source, ...args], options);
  const call = operation => scaffoldTasks(params(operation), {directory:dir}, {invokeScaffold});
  const first = await call('init');
  assert.equal(first.ok,true,JSON.stringify(first));
  const instance1 = first.data.feature.workflow.instance_id;
  assert.match(instance1,/^[a-f0-9]{32}$/);
  const dry = execFileSync('python3',['-c',script,source,'clean','--feature','F1','--dry-run'],{cwd:dir,encoding:'utf8'});
  assert.match(dry,/Affected features: 1/);
  assert.equal((await call('list')).data.feature.workflow.instance_id,instance1);
  execFileSync('python3',['-c',script,source,'clean','--feature','F1','--yes'],{cwd:dir});
  // Nothing is deleted: the closed instance's ledger stays on disk for audit.
  assert.equal((await readdir(path.join(dir,'.scaffold','features'))).length,1);
  const afterClean = await call('list');
  assert.equal(afterClean.ok,false);
  assert.equal(afterClean.reason,'COMMAND_FAILED');
  const next = await call('init');
  assert.equal(next.ok,true,JSON.stringify(next));
  assert.notEqual(next.data.feature.workflow.instance_id,instance1);
  assert.equal((await readdir(path.join(dir,'.scaffold','features'))).length,2);
  assert.notEqual(next.data.feature.direction_scope,first.data.feature.direction_scope);
  assert.equal(next.data.feature.design_ref,first.data.feature.design_ref);
});

test('Pi policies allow only scoped state tracking and preserve separate execution gates', async () => {
  for (const file of ['pi/agent/AGENTS.md', 'pi/agent/SYSTEM.md', 'pi/agent/skills/init-feature/SKILL.md']) {
    const text = (await readFile(path.join(root, file), 'utf8')).replace(/\s+/g, ' ');
    assert.match(text, /scaffold_tasks/);
    assert.match(text, /overall (?:feature )?direction|overall feature/);
    assert.match(text, /Scaffold (?:validates structure and association|does not authenticate)/);
  }
  const delivery = (await readFile(path.join(root, 'pi/agent/skills/feature-delivery/SKILL.md'), 'utf8')).replace(/\s+/g, ' ');
  assert.match(delivery, /scaffold_tasks/);
  assert.match(delivery, /\/skill:init-feature/);
  assert.match(delivery, /Only native `execute_and_review`/);
  const skill = await readFile(path.join(root, 'pi/agent/skills/scaffold/SKILL.md'), 'utf8');
  assert.match(skill, /select` returning null does not/);
  assert.match(skill, /not trusted Conductor verification/);
  for (const file of ['pi/agent/skills/scaffold/SKILL.md',
    'pi/agent/extensions/plan/index.ts', 'pi/agent/extensions/linear/index.ts']) {
    assert.doesNotMatch(await readFile(path.join(root, file), 'utf8'), /scaffold_run|push-ticket|next-step|\/skill:tdd/);
  }
  const pkg = JSON.parse(await readFile(path.join(root, 'pi/agent/extensions/scaffold/package.json'), 'utf8'));
  assert.equal(pkg.peerDependencies.typebox, '*');
});

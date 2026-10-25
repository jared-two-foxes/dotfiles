import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, mkdir, rm, chmod, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldTasks, buildCommand, OPERATIONS } from '../pi/agent/extensions/scaffold/adapter.mjs';

const root = path.resolve(import.meta.dirname, '..');
const feature = { id: 'F1', title: 'Feature', objective: 'Deliver feature', design_ref: 'approved-design@sha', acceptance_criteria: ['Feature works'] };
const definition = (id = 'T1') => ({ id, title: id, objective: 'Deliver task', acceptance_criteria: ['Task works'] });
const task = (id = 'T1', status = 'pending') => ({ ...definition(id), feature_id: 'F1', parent_id: null, status, dependencies: [], history: [] });
const evidence = { feature_id: 'F1', task_id: 'T1', result: 'PASSED', source: 'conductor', reference: 'retained-result-1', summary: 'Verified criteria' };
const params = operation => ({ operation, feature_id: 'F1',
  ...(['start', 'complete', 'block', 'fail', 'retry', 'decompose'].includes(operation) ? { task_id: 'T1' } : {}),
  ...(['block', 'fail', 'retry'].includes(operation) ? { reason: 'Explicit decision' } : {}),
  ...({ init: { payload: feature }, add: { payload: [definition()] }, complete: { payload: evidence }, decompose: { payload: [definition('child')] } }[operation] ?? {}),
});
const success = data => ({ code: 0, stdout: JSON.stringify({ schema_version: 1, ...data }), stderr: '' });
function response(operation) {
  if (['start', 'complete', 'block', 'fail', 'retry'].includes(operation)) {
    return success({ task: task('T1', { start: 'in_progress', complete: 'completed', block: 'blocked', fail: 'failed', retry: 'pending' }[operation]) });
  }
  return success({ feature: { ...feature, tasks: { T1: task() } }, ...(operation === 'next' ? { task: task() } : {}) });
}
async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'pi-scaffold-'));
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
      invokeScaffold: async (program, args, options) => {
        calls++;
        assert.equal(program, 'scaffold');
        const expected = ['tasks', operation, '--feature=F1'];
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
  const built = buildCommand({ ...params('init'), payload });
  assert.equal(built.input, JSON.stringify(payload));
  assert.deepEqual(JSON.parse(built.input), payload);
  assert.deepEqual(buildCommand({ ...params('list'), feature_id: '-literal' }).args, ['tasks', 'list', '--feature=-literal']);
  assert.deepEqual(buildCommand({ ...params('block'), reason: '--literal; $(x)' }).args.slice(-1), ['--reason=--literal; $(x)']);
});

test('required, extraneous and invalid arguments fail before invoking Scaffold', async t => {
  const dir = await fixture(t);
  const bad = [undefined, {}, { operation: 'push-ticket', feature_id: 'F1' },
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
    { code: 2, stdout: '', stderr: 'usage: scaffold tasks ...' },
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
  const base = JSON.parse(response('next').stdout);
  const invalid = ['not json', 'null', '[]', '{}',
    JSON.stringify({ ...base, schema_version: 2 }),
    JSON.stringify({ ...base, schema_version: '1' }),
    JSON.stringify({ ...base, error: 'failure' }),
    JSON.stringify({ ...base, feature: { ...base.feature, id: 'other' } }),
    JSON.stringify({ ...base, task: undefined }),
    JSON.stringify({ ...base, task: { ...task(), feature_id: 'other' } }),
    JSON.stringify({ ...base, task: { ...task(), status: 'invented' } }),
    JSON.stringify({ ...base, task: { ...task(), id: 'not-in-feature' } }),
    JSON.stringify({ ...base, feature: { ...base.feature, tasks: { wrongKey: task() } } }),
    JSON.stringify({ ...base, feature: { ...base.feature, tasks: { T1: { ...task(), history: null } } } }),
  ];
  for (const stdout of invalid) {
    const result = await scaffoldTasks(params('next'), { directory: dir }, {
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
  const empty = await scaffoldTasks(params('next'), { directory: dir }, {
    invokeScaffold: async () => success({ feature: { ...feature, tasks: { T1: task('T1', 'failed') } }, task: null }),
  });
  assert.equal(empty.ok, true);
  assert.equal(empty.data.task, null);
  assert.equal(empty.data.feature.tasks.T1.status, 'failed');
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

test('requires a current repository and refuses state symlinks', async t => {
  const dir = await fixture(t);
  const outside = await mkdtemp(path.join(tmpdir(), 'pi-scaffold-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  for (const directory of [undefined, outside]) {
    const result = await scaffoldTasks(params('list'), { directory }, { invokeScaffold: () => assert.fail('must not invoke') });
    assert.equal(result.ok, false);
  }
  if (process.platform === 'win32') return; // symlink privileges vary on Windows
  for (const suffix of ['.scaffold', '.scaffold/tasks.json', '.scaffold/.criteria-stack.lock']) {
    if (suffix !== '.scaffold') await mkdir(path.join(dir, '.scaffold'), { recursive: true });
    const target = path.join(dir, suffix);
    await symlink(outside, target);
    const result = await scaffoldTasks(params('init'), { directory: dir }, { invokeScaffold: () => assert.fail('must not follow symlink') });
    assert.equal(result.ok, false);
    assert.match(result.message, /symlinks/);
    await rm(target);
  }
});

test('production adapter only invokes Git inspection and scaffold tasks, with no file writes', async () => {
  const adapter = await readFile(path.join(root, 'pi/agent/extensions/scaffold/adapter.mjs'), 'utf8');
  const extension = await readFile(path.join(root, 'pi/agent/extensions/scaffold/index.ts'), 'utf8');
  assert.doesNotMatch(adapter, /writeFile|mkdir|unlink|rename|conductor|executor|push-ticket|next-step/i);
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
  await call({ ...params('add'), payload: [definition(), { ...definition('T2'), dependencies: ['T1'] }] });
  assert.equal((await call(params('next'))).task.id, 'T1');
  await call(params('start'));
  // Fresh module instance, no previous conversation or adapter memory.
  const fresh = await import('../pi/agent/extensions/scaffold/adapter.mjs?new-session');
  const resumed = await fresh.scaffoldTasks(params('list'), { directory: dir });
  assert.equal(resumed.ok, true);
  assert.equal(resumed.data.feature.tasks.T1.status, 'in_progress');
  assert.equal(resumed.data.feature.tasks.T2.dependencies[0], 'T1');
  assert.equal((await call(params('next'))).task, null);
  const premature = await scaffoldTasks({ ...params('start'), task_id: 'T2' }, { directory: dir });
  assert.equal(premature.ok, false);
  await call(params('complete'));
  const listed = await call(params('list'));
  assert.deepEqual(listed.feature.tasks.T1.history.at(-1).evidence, evidence);
  assert.equal((await call(params('next'))).task.id, 'T2');
  await call({ ...params('block'), task_id: 'T2' });
  await call({ ...params('retry'), task_id: 'T2' });
  await call({ ...params('start'), task_id: 'T2' });
  await call({ ...params('fail'), task_id: 'T2' });
  await call({ ...params('retry'), task_id: 'T2' });
  await call({ ...params('decompose'), task_id: 'T2' });
  assert.equal((await call(params('next'))).task.id, 'child');
  await call({ ...params('decompose'), task_id: 'child', payload: [definition('grandchild')] });
  assert.equal((await call(params('next'))).task.id, 'grandchild');
  const state = JSON.parse(await readFile(path.join(dir, '.scaffold/tasks.json'), 'utf8'));
  assert.equal(state.features.F1.tasks.T1.status, 'completed');
  assert.equal(await readFile(path.join(dir, 'application.txt'), 'utf8'), 'unchanged');
  const changed = execFileSync('git', ['-C', dir, 'ls-files', '--others', '--exclude-standard'], { encoding: 'utf8' }).trim().split('\n');
  assert.deepEqual(changed.sort(), ['.scaffold/.criteria-stack.lock', '.scaffold/tasks.json', 'application.txt'].sort());
});

test('Pi policies allow only scoped state tracking and preserve separate execution gates', async () => {
  for (const file of ['pi/agent/AGENTS.md', 'pi/agent/SYSTEM.md', 'pi/agent/skills/design/SKILL.md']) {
    const text = (await readFile(path.join(root, file), 'utf8')).replace(/\s+/g, ' ');
    assert.match(text, /scaffold_tasks/);
    assert.match(text, /separate (?:design and execution|execution)/);
    assert.match(text, /Scaffold (?:validates structure and association|does not authenticate)/);
  }
  const skill = await readFile(path.join(root, 'pi/agent/skills/scaffold/SKILL.md'), 'utf8');
  assert.match(skill, /next` returning null does not/);
  assert.match(skill, /not trusted Conductor verification/);
  for (const file of ['pi/agent/skills/scaffold/SKILL.md', 'pi/agent/skills/assisted/SKILL.md',
    'pi/agent/extensions/plan/index.ts', 'pi/agent/extensions/linear/index.ts']) {
    assert.doesNotMatch(await readFile(path.join(root, file), 'utf8'), /scaffold_run|push-ticket|next-step|\/skill:tdd/);
  }
  const pkg = JSON.parse(await readFile(path.join(root, 'pi/agent/extensions/scaffold/package.json'), 'utf8'));
  assert.equal(pkg.peerDependencies.typebox, '*');
});

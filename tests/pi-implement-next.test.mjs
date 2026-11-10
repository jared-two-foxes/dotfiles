import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describe, implementNext, parseArgs, taskPrompt } from '../pi/agent/extensions/implement-next/loop.mjs';

const task = id => ({ featureId: 'f', taskId: id, designRef: 'sha256:' + 'a'.repeat(64) });

test('parseArgs defaults to one task and accepts a feature id, --max and --all', () => {
  assert.deepEqual(parseArgs(''), { featureId: undefined, max: 1 });
  assert.deepEqual(parseArgs('feat --max=3'), { featureId: 'feat', max: 3 });
  assert.equal(parseArgs('--all').max, Infinity);
  for (const bad of ['--max=0', '--max=x', 'a b', '--nope']) assert.throws(() => parseArgs(bad), /Usage/);
});

test('prompt carries identity only and invokes implement-task', () => {
  const p = taskPrompt(task('t1'));
  assert.match(p, /^\/skill:implement-task /);
  // Pi splits the skill name at the first literal space, not at a newline.
  assert.equal(p.slice('/skill:'.length).split(' ')[0], 'implement-task');
  assert.match(p, /taskId: t1/);
  assert.match(p, /task\.designRef: sha256:/);
});

test('runs one fresh session per issue until none are eligible', async () => {
  const queue = [task('a'), task('b')];
  const ran = [];
  const result = await implementNext({
    max: Infinity,
    selectNext: async () => queue.shift() ?? null,
    runTask: async t => { ran.push(t.taskId); },
    statusOf: async () => 'completed',
  });
  assert.deepEqual(ran, ['a', 'b']);
  assert.deepEqual(result, { stopped: 'no-eligible-issue', completed: ['a', 'b'] });
  assert.match(describe(result), /not proof the feature is complete/);
});

test('stops at max', async () => {
  let n = 0;
  const result = await implementNext({
    max: 2, selectNext: async () => task('t' + n++), runTask: async () => {}, statusOf: async () => 'completed',
  });
  assert.equal(result.stopped, 'max-reached');
  assert.equal(result.completed.length, 2);
});

test('stops without advancing when Scaffold does not show the issue completed', async () => {
  let selects = 0;
  const result = await implementNext({
    max: Infinity,
    selectNext: async () => { selects++; return task('a'); },
    runTask: async () => {},
    statusOf: async () => 'blocked',
  });
  assert.equal(selects, 1);
  assert.equal(result.stopped, 'not-completed');
  assert.equal(result.status, 'blocked');
  assert.match(describe(result), /Issue a ended blocked/);
});

test('a failing child session propagates and nothing is marked completed', async () => {
  await assert.rejects(implementNext({
    max: 1, selectNext: async () => task('a'), runTask: async () => { throw new Error('boom'); }, statusOf: async () => 'completed',
  }), /boom/);
});

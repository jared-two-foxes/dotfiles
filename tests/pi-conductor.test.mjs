import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { executeAndReview } from '../pi/agent/extensions/conductor/adapter.mjs';

async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'pi-conductor-adapter-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.invalid');
  await writeFile(path.join(dir, 'source.txt'), 'before');
  git('add', 'source.txt');
  git('commit', '-qm', 'baseline');
  const baseRef = git('rev-parse', 'HEAD');
  const input = JSON.stringify({ operations: [
    { type: 'create_file', path: 'new.txt', content: 'ok' },
  ] });
  const args = {
    input, baseRef, requirements: 'Preserve approved behavior',
    buildCommand: ['cargo', 'build'], testCommand: ['cargo', 'test'],
  };
  return { dir, git, baseRef, input, args };
}

function fake(status, phase = 'review') {
  const code = { PASSED: 0, NEEDS_DESIGN: 2, BLOCKED: 3 }[status];
  return { code, stdout: JSON.stringify({
    schema: 'conductor.result/v1', status, phase,
    execution: { success: true, operations_applied: 1 },
    checks: [], review: null, error: null,
  }), stderr: '' };
}

test('translates exact executor operations and fixed baseline to one Conductor request', async t => {
  const f = await fixture(t);
  const calls = [];
  const outcome = await executeAndReview(f.args, { worktree: f.dir }, {
    invokeConductor: async json => { calls.push(JSON.parse(json)); return fake('PASSED'); },
  });
  assert.equal(outcome.status, 'PASSED');
  assert.equal(outcome.stage, 'REVIEW');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].execution, JSON.parse(f.input));
  assert.equal(calls[0].repository_path, f.dir);
  assert.equal(calls[0].review.base_ref, f.baseRef);
  assert.equal(calls[0].review.requirements, f.args.requirements);
  assert.equal(calls[0].review.model, 'opencode/gpt-6.1-sol');
  assert.deepEqual(calls[0].checks, [
    { name: 'build', program: 'cargo', args: ['build'] },
    { name: 'test', program: 'cargo', args: ['test'] },
  ]);
});

test('propagates Conductor NEEDS_DESIGN and BLOCKED without retries', async t => {
  const f = await fixture(t);
  for (const [status, phase] of [['NEEDS_DESIGN', 'execution'], ['NEEDS_DESIGN', 'verification'],
    ['NEEDS_DESIGN', 'review'], ['BLOCKED', 'review']]) {
    let calls = 0;
    const result = await executeAndReview(f.args, { worktree: f.dir }, {
      invokeConductor: async () => { calls++; return fake(status, phase); },
    });
    assert.equal(result.status, status);
    assert.equal(result.stage, phase.toUpperCase());
    assert.equal(calls, 1);
  }
});

test('changed HEAD blocks before Conductor invocation', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.dir, 'other.txt'), 'new');
  f.git('add', 'other.txt');
  f.git('commit', '-qm', 'next');
  const result = await executeAndReview(f.args, { worktree: f.dir }, {
    invokeConductor: () => { throw new Error('should not invoke'); },
  });
  assert.equal(result.status, 'BLOCKED');
  assert.equal(result.reason, 'HEAD_CHANGED');
});

test('invalid inputs block before invoking Conductor', async t => {
  const f = await fixture(t);
  for (const patch of [{ input: '{broken' }, { input: '{"patches":[]}' },
    { buildCommand: [] }, { baseRef: 'HEAD' }]) {
    const result = await executeAndReview({ ...f.args, ...patch }, { worktree: f.dir }, {
      invokeConductor: () => { throw new Error('should not invoke'); },
    });
    assert.equal(result.status, 'BLOCKED');
  }
});

test('rejects malformed response and exit-code disagreement', async t => {
  const f = await fixture(t);
  for (const response of [
    { code: 0, stdout: 'not json', stderr: '' },
    { ...fake('PASSED'), code: 2 },
    { ...fake('PASSED'), stdout: '{"schema":"wrong","status":"PASSED"}' },
  ]) {
    const result = await executeAndReview(f.args, { worktree: f.dir }, {
      invokeConductor: async () => response,
    });
    assert.equal(result.status, 'BLOCKED');
  }
});

test('missing Conductor binary blocks without modifying files', async t => {
  const f = await fixture(t);
  const previous = process.env.CONDUCTOR_BIN;
  process.env.CONDUCTOR_BIN = 'nonexistent-conductor-binary-7f31d';
  try {
    const result = await executeAndReview(f.args, { worktree: f.dir });
    assert.equal(result.status, 'BLOCKED');
    assert.equal(result.reason, 'EXECUTABLE_NOT_FOUND');
  } finally {
    if (previous === undefined) delete process.env.CONDUCTOR_BIN;
    else process.env.CONDUCTOR_BIN = previous;
  }
});

test('real subprocess receives JSON on stdin without shell or scratch files', async t => {
  const f = await fixture(t);
  const script = path.join(f.dir, 'fake-conductor.cjs');
  await writeFile(script, `
let body = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => body += chunk);
process.stdin.on('end', () => {
  const request = JSON.parse(body);
  if (process.argv.slice(2).join(' ') !== 'run --request -') process.exit(9);
  process.stdout.write(JSON.stringify({
    schema: 'conductor.result/v1', status: 'PASSED', phase: 'review',
    execution: { success: true, operations_applied: request.execution.operations.length },
    checks: [], review: null, error: null,
  }));
});
`);
  // Use the running Node binary as a portable launcher for the mock executable.
  // The adapter's CONDUCTOR_BIN is one executable, so this wrapper is an executable
  // POSIX script on Unix; on Windows use a separate injection test above.
  if (process.platform === 'win32') return;
  const { chmod } = await import('node:fs/promises');
  await writeFile(path.join(f.dir, 'conductor-mock'), '#!/bin/sh\nexec "' + process.execPath + '" "' + script + '" "$@"\n');
  await chmod(path.join(f.dir, 'conductor-mock'), 0o755);
  const previous = process.env.CONDUCTOR_BIN;
  process.env.CONDUCTOR_BIN = path.join(f.dir, 'conductor-mock');
  try {
    const result = await executeAndReview(f.args, { worktree: f.dir });
    assert.equal(result.status, 'PASSED');
    assert.equal(result.conductor.execution.operations_applied, 1);
  } finally {
    if (previous === undefined) delete process.env.CONDUCTOR_BIN;
    else process.env.CONDUCTOR_BIN = previous;
  }
});

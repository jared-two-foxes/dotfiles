import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { executeAndReview } from '../opencode/scripts/execute-and-review.mjs';

async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'execute-review-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.invalid');
  await writeFile(path.join(dir, 'source.txt'), 'before');
  git('add', 'source.txt'); git('commit', '-qm', 'baseline');
  const baseRef = git('rev-parse', 'HEAD');
  const build = path.join(dir, 'build.cjs');
  const testScript = path.join(dir, 'test.cjs');
  await writeFile(path.join(dir, '.git/info/exclude'), 'build.cjs\ntest.cjs\n');
  await writeFile(build, "console.log('built');");
  await writeFile(testScript, "console.log('# tests 2\\n# pass 2');");
  const calls = [];
  const apply = async (input) => {
    calls.push(['apply', input.input]);
    return { status: 'APPLIED', operationsApplied: 1 };
  };
  const review = async (args) => {
    calls.push(['review', args]);
    return { status: 'APPROVED', review_id: 'fake-review', blockingFindings: [], suggestions: [] };
  };
  const input = JSON.stringify({ operations: [{ type: 'create_file', path: 'new.txt', content: 'ok' }] });
  const args = { input, requirements: 'Keep the agreed algorithm; add regression tests',
    baseRef, buildCommand: [process.execPath, build], testCommand: [process.execPath, testScript] };
  return { dir, git, baseRef, build, testScript, calls, apply, review, args };
}

test('one attempt applies, builds, verifies nonzero tests and reviews fixed baseline', async t => {
  const f = await fixture(t);
  const outcome = await executeAndReview(f.args, { worktree: f.dir },
    { apply: f.apply, review: f.review, skipDependencyCheck: true });
  assert.equal(outcome.status, 'PASSED');
  assert.equal(outcome.stage, 'REVIEW');
  assert.equal(outcome.tests.executed, 2);
  assert.deepEqual(f.calls.map(x => x[0]), ['apply', 'review']);
  assert.equal(f.calls[0][1], f.args.input);
  assert.equal(f.calls[1][1].baseRef, f.baseRef);
  assert.equal(f.calls[1][1].requirements, f.args.requirements);
  assert.equal(f.calls[1][1].model, 'opencode/gpt-6.1-sol');
});

test('build failure returns to Design without testing or reviewing', async t => {
  const f = await fixture(t);
  await writeFile(f.build, "console.error('compiler error'); process.exit(1)");
  const outcome = await executeAndReview(f.args, { worktree: f.dir },
    { apply: f.apply, review: f.review, skipDependencyCheck: true });
  assert.equal(outcome.status, 'NEEDS_DESIGN');
  assert.equal(outcome.stage, 'BUILD');
  assert.match(outcome.build.output, /compiler error/);
  assert.deepEqual(f.calls.map(x => x[0]), ['apply']);
});

test('test failure returns to Design with output', async t => {
  const f = await fixture(t);
  await writeFile(f.testScript, "console.log('# tests 2\\n# pass 1'); process.exit(1)");
  const outcome = await executeAndReview(f.args, { worktree: f.dir },
    { apply: f.apply, review: f.review, skipDependencyCheck: true });
  assert.equal(outcome.status, 'NEEDS_DESIGN');
  assert.equal(outcome.stage, 'TEST');
  assert.deepEqual(f.calls.map(x => x[0]), ['apply']);
});

test('zero or unrecognized executed tests cannot pass', async t => {
  const f = await fixture(t);
  await writeFile(f.testScript, "console.log('# tests 0\\n# pass 0')");
  const outcome = await executeAndReview(f.args, { worktree: f.dir },
    { apply: f.apply, review: f.review, skipDependencyCheck: true });
  assert.equal(outcome.status, 'BLOCKED');
  assert.equal(outcome.reason, 'NO_TEST_EVIDENCE');
  assert.deepEqual(f.calls.map(x => x[0]), ['apply']);
});

test('custom test evidence pattern can validate an unsupported test runner', async t => {
  const f = await fixture(t);
  await writeFile(f.testScript, "console.log('checks executed: 4')");
  const outcome = await executeAndReview({
    ...f.args, testEvidencePattern: 'checks executed: (\\d+)',
  }, { worktree: f.dir }, { apply: f.apply, review: f.review, skipDependencyCheck: true });
  assert.equal(outcome.status, 'PASSED');
  assert.equal(outcome.tests.executed, 4);
});

test('source changes from tests block review rather than silently approving', async t => {
  const f = await fixture(t);
  await writeFile(f.testScript, "require('node:fs').writeFileSync('source.txt', 'mutated'); console.log('# tests 1\\n# pass 1')");
  const outcome = await executeAndReview(f.args, { worktree: f.dir },
    { apply: f.apply, review: f.review, skipDependencyCheck: true });
  assert.equal(outcome.status, 'BLOCKED');
  assert.equal(outcome.reason, 'SOURCE_CHANGED');
  assert.deepEqual(f.calls.map(x => x[0]), ['apply']);
});

test('partial executor failure returns immediately without review', async t => {
  const f = await fixture(t);
  const outcome = await executeAndReview(f.args, { worktree: f.dir }, {
    skipDependencyCheck: true, apply: async () => ({ status: 'APPLY_FAILED', operationsApplied: 0, failedOperation: 0, error: 'conflict' }),
    review: f.review, skipDependencyCheck: true,
  });
  assert.equal(outcome.status, 'NEEDS_DESIGN');
  assert.equal(outcome.stage, 'APPLY');
  assert.match(outcome.message, /partial/);
  assert.equal(f.calls.length, 0);
});

test('review rejection returns findings to Design, indeterminate blocks', async t => {
  const f = await fixture(t);
  for (const [verdict, expected] of [['CHANGES_REQUESTED', 'NEEDS_DESIGN'],
    ['INDETERMINATE', 'BLOCKED'], ['ERROR', 'BLOCKED']]) {
    const outcome = await executeAndReview(f.args, { worktree: f.dir }, {
      apply: f.apply, skipDependencyCheck: true, review: async () => ({ status: verdict, blockingFindings: [{ message: 'bad' }] }),
    });
    assert.equal(outcome.status, expected);
    assert.equal(outcome.stage, 'REVIEW');
  }
});

test('changed HEAD and invalid inputs stop before executor', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.dir, 'other.txt'), 'next');
  f.git('add', 'other.txt'); f.git('commit', '-qm', 'new HEAD');
  const changed = await executeAndReview(f.args, { worktree: f.dir },
    { apply: f.apply, review: f.review, skipDependencyCheck: true });
  assert.equal(changed.status, 'BLOCKED');
  assert.equal(changed.reason, 'HEAD_CHANGED');
  assert.equal(f.calls.length, 0);
  const invalid = await executeAndReview({ ...f.args, buildCommand: ['echo hi'] },
    { worktree: f.dir }, { apply: f.apply, review: f.review, skipDependencyCheck: true });
  assert.equal(invalid.status, 'BLOCKED');
});

test('missing build binary blocks, never triggers review', async t => {
  const f = await fixture(t);
  const outcome = await executeAndReview({ ...f.args,
    buildCommand: [path.join(f.dir, 'no-such-binary')] }, { worktree: f.dir },
  { apply: f.apply, review: f.review, skipDependencyCheck: true });
  assert.equal(outcome.status, 'BLOCKED');
  assert.equal(outcome.reason, 'EXECUTABLE_NOT_FOUND');
  assert.deepEqual(f.calls.map(x => x[0]), ['apply']);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { applyExecutor } from '../opencode/scripts/executor-runner.mjs';

async function fixture(t, behavior = 'success') {
  const dir = await mkdtemp(path.join(tmpdir(), 'executor-tool-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q');
  const stub = path.join(dir, 'fake-executor.cjs');
  await writeFile(stub, `
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args.join(' ') !== 'apply -') process.exit(9);
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  const request = JSON.parse(input);
  fs.writeFileSync(path.join(process.cwd(), 'capture.json'), input);
  const behavior = ${JSON.stringify(behavior)};
  if (behavior === 'partial') {
    fs.writeFileSync(path.join(process.cwd(), 'partial.txt'), 'partial');
    console.log(JSON.stringify({success:false,operations_applied:1,failed_operation:1,error:'conflict'}));
    process.exit(1);
  }
  if (behavior === 'mismatch') {
    console.log(JSON.stringify({success:true,operations_applied:request.operations.length}));
    process.exit(1);
  }
  if (behavior === 'invalid') { console.log('invalid'); process.exit(0); }
  console.log(JSON.stringify({success:true,operations_applied:request.operations.length}));
});
`);
  const input = JSON.stringify({ operations: [
    { type: 'create_file', path: 'a.txt', content: 'hello' },
    { type: 'delete_file', path: 'b.txt' },
  ] });
  return { dir, stub, input, options: { executable: process.execPath, prefixArgs: [stub] } };
}

test('passes the complete input on stdin in the current Git root', async t => {
  const f = await fixture(t);
  const result = await applyExecutor({ input: f.input }, { worktree: f.dir }, f.options);
  assert.equal(result.status, 'APPLIED');
  assert.equal(result.operationsApplied, 2);
  assert.equal(result.repository, f.dir);
  assert.equal(await readFile(path.join(f.dir, 'capture.json'), 'utf8'), f.input);
});

test('reports partial application and never retries or rolls back', async t => {
  const f = await fixture(t, 'partial');
  const result = await applyExecutor({ input: f.input }, { directory: f.dir }, f.options);
  assert.equal(result.status, 'APPLY_FAILED');
  assert.equal(result.operationsApplied, 1);
  assert.equal(result.failedOperation, 1);
  assert.equal(result.error, 'conflict');
  assert.equal(await readFile(path.join(f.dir, 'partial.txt'), 'utf8'), 'partial');
});

for (const behavior of ['mismatch', 'invalid']) {
  test(`rejects ${behavior} result rather than claiming success`, async t => {
    const f = await fixture(t, behavior);
    assert.equal((await applyExecutor({ input: f.input }, { worktree: f.dir }, f.options)).status, 'ERROR');
  });
}

test('rejects invalid input before launching the executable', async t => {
  const f = await fixture(t);
  for (const input of ['', 'not-json', '{}', '{"operations":{},"extra":1}']) {
    const result = await applyExecutor({ input }, { worktree: f.dir }, f.options);
    assert.equal(result.status, 'ERROR');
  }
});

test('missing executor and non-Git workspaces are errors', async t => {
  const f = await fixture(t);
  const missing = await applyExecutor({ input: f.input }, { worktree: f.dir },
    { executable: path.join(f.dir, 'missing-binary') });
  assert.equal(missing.status, 'ERROR');
  assert.equal(missing.reason, 'EXECUTABLE_NOT_FOUND');
  const other = await mkdtemp(path.join(tmpdir(), 'not-a-repo-'));
  t.after(() => rm(other, { recursive: true, force: true }));
  const result = await applyExecutor({ input: f.input }, { worktree: other }, f.options);
  assert.equal(result.status, 'ERROR');
});

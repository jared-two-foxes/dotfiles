import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm, chmod } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { executeAndReview } from '../pi/agent/extensions/conductor/adapter.mjs';
import { authenticateTaskEvidence } from '../pi/agent/extensions/conductor/task-evidence.mjs';
import { readEvidence, retainEvidence, snapshot } from '../pi/agent/extensions/conductor/evidence.mjs';
import { executionSummary } from '../pi/agent/extensions/conductor/protocol.mjs';

const conductorFixture = `
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
let input = ''; for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input), commands = [];
const directory = fs.mkdtempSync(path.join(request.output_directory, 'runner-'));
let status = 'PASSED', error;
for (const [index, command] of request.commands.entries()) {
  const stdout_path = path.join(directory, String(index).padStart(6, '0') + '.stdout');
  const stderr_path = path.join(directory, String(index).padStart(6, '0') + '.stderr');
  const out = fs.openSync(stdout_path, 'wx'), err = fs.openSync(stderr_path, 'wx');
  const result = spawnSync(command.program, command.args, { cwd: request.working_directory, stdio: ['ignore', out, err] });
  fs.closeSync(out); fs.closeSync(err);
  status = result.error ? 'BLOCKED' : result.status === 0 ? 'PASSED' : 'FAILED';
  const stdout = fs.readFileSync(stdout_path, 'utf8'), stderr = fs.readFileSync(stderr_path, 'utf8');
  commands.push({ ...command, index, status, exit_code: result.status,
    stdout: stdout.slice(0, 16384), stderr: stderr.slice(0, 16384),
    stdout_truncated: stdout.length > 16384, stderr_truncated: stderr.length > 16384, stdout_path, stderr_path });
  if (status !== 'PASSED') { error = 'command failed'; break; }
}
console.log(JSON.stringify({ schema: 'conductor.result/v2', status, commands, output_directory: directory,
  phase: status === 'PASSED' ? 'completed' : 'commands',
  ...(error ? { error, failed_command_index: commands.length - 1 } : {}) }));
process.exitCode = { PASSED: 0, FAILED: 1, BLOCKED: 2 }[status];
`;
const executorFixture = `
import fs from 'node:fs';
if (process.argv[2] !== 'apply') throw Error('executor invocation');
const input = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
for (const operation of input.operations) {
  if (operation.type !== 'edit_file') throw Error('fixture supports edit_file');
  let text = fs.readFileSync(operation.path, 'utf8');
  for (const edit of operation.edits) text = text.replace(edit.oldText, edit.newText);
  fs.writeFileSync(operation.path, text);
}
fs.appendFileSync('.git/trace', 'executor\\n');
console.log(JSON.stringify({ success: true, operations_applied: input.operations.length, affected_files: ['source.txt'] }));
`;
const reviewFixture = `
import fs from 'node:fs';
const args = process.argv.slice(2), value = flag => args[args.indexOf(flag) + 1];
const request = JSON.parse(fs.readFileSync(value('--request'), 'utf8'));
if (request.schema !== 'review.request/v1' || request.head_ref !== ':working' ||
  fs.readFileSync(request.requirements, 'utf8') !== 'Complete immutable review requirements') throw Error('review contract');
fs.appendFileSync('.git/trace', 'review\\n');
const status = process.env.REVIEW_FIXTURE_STATUS;
console.log(JSON.stringify({ schema: 'review.result/v1', status, review_id: 'external-review',
  reason: status === 'INDETERMINATE' ? 'BUDGET_EXHAUSTED' : 'REVIEW_COMPLETED', completed_at: '2026-11-01T00:00:00Z',
  findings: status === 'CHANGES_REQUESTED' ? [{ severity: 'high', blocking: true, message: 'Correct the edge case' }] : [],
  padding: 'x'.repeat(40000) }));
process.exitCode = { APPROVED: 0, CHANGES_REQUESTED: 1, INDETERMINATE: 3 }[status];
`;

test('real command sequence preserves full output, review boundary and immutable checkpoint evidence',
  { skip: process.platform === 'win32' ? 'Executable Node fixtures use POSIX shebangs; wire tests are portable' : false }, async t => {
    for (const [mode, expected] of [['APPROVED', 'PASSED'], ['CHANGES_REQUESTED', 'NEEDS_DESIGN'],
      ['INDETERMINATE', 'BLOCKED'], ['FAILED_CHECK', 'NEEDS_DESIGN']]) {
      await t.test(mode, async t => {
        const directory = await mkdtemp(path.join(tmpdir(), 'pi-v2-integration-'));
        t.after(() => rm(directory, { recursive: true, force: true }));
        const git = (...args) => execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim();
        git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
        await writeFile(path.join(directory, 'source.txt'), 'before'); git('add', '.'); git('commit', '-qm', 'baseline');
        const binaries = {};
        for (const [name, source] of [['conductor', conductorFixture], ['executor', executorFixture], ['review', reviewFixture]]) {
          const file = path.join(directory, '.git', name + '.mjs');
          await writeFile(file, '#!/usr/bin/env node\n' + source); await chmod(file, 0o755); binaries[name] = file;
        }
        const saved = Object.fromEntries(['CONDUCTOR_BIN', 'EXECUTOR_BIN', 'REVIEW_CLI_BIN', 'REVIEW_FIXTURE_STATUS'].map(k => [k, process.env[k]]));
        Object.assign(process.env, { CONDUCTOR_BIN: process.env.CONDUCTOR_TEST_BIN ?? binaries.conductor,
          EXECUTOR_BIN: binaries.executor, REVIEW_CLI_BIN: binaries.review, REVIEW_FIXTURE_STATUS: mode });
        t.after(() => { for (const [key, value] of Object.entries(saved)) {
          if (value === undefined) delete process.env[key]; else process.env[key] = value;
        } });
        const args = { task: { featureId: 'F', taskId: 'T', designRef: 'approved' }, baseRef: git('rev-parse', 'HEAD'),
          requirements: 'Complete immutable review requirements',
          input: JSON.stringify({ operations: [{ type: 'edit_file', path: 'source.txt', edits: [{ oldText: 'before', newText: 'after' }] }] }),
          checks: [{ name: 'targeted regression', command: [process.execPath, '-e',
            'require("fs").appendFileSync(".git/trace", "check\\n"); console.log("3 tests passed");' +
              (mode === 'FAILED_CHECK' ? 'process.exit(7);' : '')] }] };
        const result = await executeAndReview(args, { directory });
        assert.equal(result.status, expected, JSON.stringify(result));
        assert.equal(await readFile(path.join(directory, 'source.txt'), 'utf8'), 'after');
        assert.equal(await readFile(path.join(directory, '.git/trace'), 'utf8'),
          mode === 'FAILED_CHECK' ? 'executor\ncheck\n' : 'executor\ncheck\nreview\n');
        const record = await readEvidence(directory, result.evidence.reference);
        assert.equal(record.request.schema, 'conductor.request/v2');
        assert.equal(record.workflow.inputs.requirements, args.requirements);
        if (mode !== 'FAILED_CHECK') {
          const review = result.conductor.runner.commands.at(-1);
          assert.equal(review.stdout_truncated, true);
          assert.equal(JSON.parse(await readFile(review.stdout_path, 'utf8')).padding.length, 40000);
        }
        if (mode === 'APPROVED') {
          assert.equal(record.reviewSnapshot.tree, record.after.tree);
          assert.equal(executionSummary(result).conductor.toolOutputs, undefined);
          const tampered = await retainEvidence(directory, { ...record,
            workflow: { ...record.workflow, inputs: { ...record.workflow.inputs, requirements: 'weakened' } } });
          await assert.rejects(authenticateTaskEvidence(directory, tampered, args.task), /tool input mismatch/);
          // Successful evidence is self-contained; log/request cleanup cannot forge
          // success, nor invalidate the immutable successful receipt after the fact.
          await rm(record.request.output_directory, { recursive: true });
          assert.equal((await authenticateTaskEvidence(directory, result.evidence.reference, args.task)).attempt, 1);
        }
      });
    }
  });

test('independently installed Pi and OpenCode protocol helpers remain identical', async () => {
  assert.equal(await readFile(new URL('../pi/agent/extensions/conductor/protocol.mjs', import.meta.url), 'utf8'),
    await readFile(new URL('../opencode/scripts/conductor-protocol.mjs', import.meta.url), 'utf8'));
});

test('historical complete v1 receipts remain authentic after the adapter upgrade', async t => {
  const repository = await mkdtemp(path.join(tmpdir(), 'pi-v1-evidence-'));
  t.after(() => rm(repository, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim();
  git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
  await writeFile(path.join(repository, 'source.txt'), 'baseline'); git('add', '.'); git('commit', '-qm', 'baseline');
  const args = { task: { featureId: 'F', taskId: 'T', designRef: 'approved' },
    baseRef: git('rev-parse', 'HEAD'), requirements: 'Original v1 criteria', input: '{"operations":[]}',
    buildCommand: ['build'], testCommand: ['test'] };
  const before = await snapshot(repository);
  const conductor = { schema: 'conductor.result/v1', status: 'PASSED', phase: 'review',
    execution: { success: true, operations_applied: 0 }, checks: ['build', 'test'].map(name => ({ name, exit_code: 0 })),
    review: { status: 'APPROVED' } };
  const reference = await retainEvidence(repository, { repository, args, task: args.task, attempt: 1,
    before, after: before, reviewSnapshot: before,
    request: { schema: 'conductor.request/v1', review: { base_ref: args.baseRef, requirements: args.requirements },
      checks: [{ name: 'build', program: 'build', args: [] }, { name: 'test', program: process.execPath,
        args: ['test-boundary.mjs', JSON.stringify({ command: ['test'] })] }] },
    response: { code: 0, stdout: JSON.stringify(conductor), stderr: '' }, result: { status: 'PASSED', conductor } });
  assert.equal((await authenticateTaskEvidence(repository, reference, args.task)).attempt, 1);
});

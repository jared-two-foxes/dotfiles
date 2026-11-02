import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, chmod, rm, readdir, symlink } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { executeAndCheckpoint, finalizeVerifiedTask } from '../pi/agent/extensions/conductor/delivery.mjs';
import { invoke } from '../pi/agent/extensions/conductor/adapter.mjs';
import { scaffoldTasks, designReference } from '../pi/agent/extensions/scaffold/adapter.mjs';
import { approveFeatureDirection, featureAuthorized } from '../pi/agent/extensions/conductor/feature-authorization.mjs';
import { validateFeature } from '../pi/agent/extensions/conductor/feature.mjs';
import { issueDesignRequirements, issueRequirements } from '../pi/agent/extensions/conductor/issue-state.mjs';
import { readEvidence, retainEvidence } from '../pi/agent/extensions/conductor/evidence.mjs';
import { authenticateTaskEvidence } from '../pi/agent/extensions/conductor/task-evidence.mjs';
import { conductorFixture, executorFixture, reviewFixture } from './helpers/conductor-executables.mjs';
import { approveGraph } from './helpers/issue-plan.mjs';
import { inspectIssueAttempt } from '../pi/agent/extensions/conductor/issue-context.mjs';
import { authenticateAttemptChain } from '../pi/agent/extensions/conductor/task-chain.mjs';

const integration = { skip: process.platform === 'win32' || !process.env.SCAFFOLD_SOURCE
  ? 'Requires real Scaffold and POSIX executable fixtures' : false };

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-auto-commit-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
  await writeFile(path.join(directory, '.gitignore'), '.scaffold/\n');
  await writeFile(path.join(directory, 'source.txt'), 'before'); git('add', '.'); git('commit', '-qm', 'baseline');
  git('switch', '-qc', 'feature/automatic');
  const base = git('rev-parse', 'HEAD');
  const bin = path.join(directory, '.git', 'bin');
  await import('node:fs/promises').then(fs => fs.mkdir(bin));
  for (const [name, source] of [['conductor', conductorFixture], ['executor', executorFixture], ['review-cli', reviewFixture]]) {
    await writeFile(path.join(bin, name), '#!/usr/bin/env node\n' + source); await chmod(path.join(bin, name), 0o755);
  }
  await writeFile(path.join(bin, 'scaffold'), '#!/usr/bin/env python3\nimport sys,os\n' +
    'if os.environ.get("FAIL_SCAFFOLD_COMPLETE") and sys.argv[1:3] == ["tasks", "complete"]: sys.exit(9)\n' +
    'sys.path.insert(0, ' +
    JSON.stringify(path.join(process.env.SCAFFOLD_SOURCE, 'src')) + ')\nfrom scaffold_cli.cli import main\nmain()\n');
  await chmod(path.join(bin, 'scaffold'), 0o755);
  const saved = Object.fromEntries(['PATH', 'CONDUCTOR_BIN', 'EXECUTOR_BIN', 'REVIEW_CLI_BIN', 'REVIEW_FIXTURE_STATUS', 'EXPECTED_REVIEW_REQUIREMENTS', 'REVIEW_FIXTURE_LOCK', 'REVIEW_FIXTURE_DRIFT', 'REVIEW_FIXTURE_MALFORMED', 'REVIEW_FIXTURE_TAMPER', 'REVIEW_FIXTURE_TERMINAL_LOCK'].map(k => [k, process.env[k]]));
  Object.assign(process.env, { PATH: bin + path.delimiter + process.env.PATH,
    CONDUCTOR_BIN: process.env.CONDUCTOR_TEST_BIN ?? path.join(bin, 'conductor'),
    EXECUTOR_BIN: path.join(bin, 'executor'), REVIEW_CLI_BIN: path.join(bin, 'review-cli'), REVIEW_FIXTURE_STATUS: 'APPROVED' });
  t.after(() => { for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  } });
  const context = { directory };
  const call = async (operation, rest = {}) => {
    const response = await scaffoldTasks({ operation, feature_id: 'F', ...rest }, context);
    assert.equal(response.ok, true, JSON.stringify(response)); return response.data;
  };
  const design = 'Approved automatic local task delivery';
  await call('init', { payload: { id: 'F', title: 'Automatic commit', objective: 'Deliver a reviewed change',
    acceptance_criteria: ['Source says after'], context: design, design_ref: designReference(design),
    baseline: base, branch: 'feature/automatic' } });
  await approveGraph(call);
  let confirmations = 0;
  const approval = await approveFeatureDirection({ featureId: 'F' }, context, { confirm: async () => { confirmations++; return true; } });
  assert.equal(approval.ok, true, JSON.stringify(approval));
  await call('start', { task_id: 'F' });
  const task = (await call('list')).feature.tasks.F;
  const requirements = task.acceptance_criteria.join('\n') + issueDesignRequirements(task);
  process.env.EXPECTED_REVIEW_REQUIREMENTS = requirements;
  const args = { task: { featureId: 'F', taskId: 'F', designRef: designReference(design) }, baseRef: base, requirements,
    checkpoint: { defaultBranch: 'main', protectedBranches: [] },
    input: JSON.stringify({ operations: [{ type: 'edit_file', path: 'source.txt', edits: [{ oldText: 'before', newText: 'after' }] }] }),
    checks: [{ name: 'targeted regression', command: [process.execPath, '-e',
      'require("fs").appendFileSync(".git/trace", "check\\n");console.log("3 tests passed")'] }] };
  const finalizeArgs = result => ({ task: args.task, evidenceRef: result.evidence.reference, featureBaseRef: base,
    branch: 'feature/automatic', defaultBranch: 'main', protectedBranches: [] });
  const finalCommand = body => invoke(process.env.CONDUCTOR_BIN, ['run', '--request', '-'], { cwd: directory, input: body });
  return { directory, git, base, args, context, call, finalizeArgs, finalCommand, confirmations: () => confirmations };
}

test('successful review automatically completes the task and runs a verified commit command', integration, async t => {
  const f = await fixture(t);
  const issue = (await f.call('list')).feature.tasks.F;
  const expected = issueRequirements(issue, '');
  process.env.EXPECTED_REVIEW_REQUIREMENTS = expected;
  f.args.requirements = '';
  let calls = 0;
  const result = await executeAndCheckpoint(f.args, f.context, { invokeConductor: body => { calls++; return f.finalCommand(body); } });
  assert.equal(calls, 1, 'all stages including Git commit must use ONE Conductor call');
  assert.equal(result.status, 'PASSED', JSON.stringify(result));
  assert.equal(result.stage, 'COMMITTED');
  assert.equal(result.implementationStatus, 'PASSED');
  assert.equal(result.nextBaseRef, f.git('rev-parse', 'HEAD'));
  assert.equal(f.git('rev-list', '--count', f.base + '..HEAD'), '1');
  assert.equal(f.git('status', '--porcelain'), '');
  const task = (await f.call('list')).feature.tasks.F;
  assert.equal(task.status, 'completed'); assert.equal(task.checkpoint.commit, result.nextBaseRef);
  const record = await readEvidence(f.directory, result.evidence.reference);
  assert.equal(record.args.requirements, expected);
  assert.equal(record.after.head, f.base); assert.equal(record.result.status, 'PASSED');
  assert.equal(f.git('rev-parse', 'HEAD^{tree}'), record.after.tree);
  const request = JSON.parse(await readFile(path.join(result.checkpoint.finalizationDirectory, 'request.json'), 'utf8'));
  assert.deepEqual(request.commands.map(c => c.name), ['executor', 'targeted regression', 'review', 'git commit verified task']);
  assert.match(request.commands.at(-1).args[0], /commit-task\.mjs$/);
  const full = JSON.parse(await readFile(path.join(result.checkpoint.finalizationDirectory, 'response.json'), 'utf8'));
  assert.equal(JSON.parse(full.stdout).commands.at(-1).name, 'git commit verified task');
  assert.equal(record.response && JSON.parse(record.response.stdout).schema, 'pi.command-results/v1');
  assert.match(f.git('show', '-s', '--format=%B'), /Pi-Task-Checkpoint:/);
  assert.equal(f.confirmations(), 1);
  // Automatic task commits still feed the mandatory cumulative feature gate.
  process.env.EXPECTED_REVIEW_REQUIREMENTS = '*';
  const featureArgs = { featureId: 'F', designRef: f.args.task.designRef, branch: 'feature/automatic',
    featureBaseRef: f.base, headRef: result.nextBaseRef,
    buildCommand: [process.execPath, '-e', 'console.log("build passed")'],
    testCommand: [process.execPath, '-e', 'console.log("3 tests passed")'], testSuccessPattern: '3 tests passed' };
  const validation = await validateFeature(featureArgs, f.context, { authorize: () => featureAuthorized(featureArgs, f.context) });
  assert.equal(validation.status, 'PASSED', JSON.stringify(validation));
  assert.equal(f.git('rev-list', '--count', f.base + '..HEAD'), '1');
  for (const change of [r => { r.producer = 'unverified'; },
    r => { r.deliveryRequest.commands.pop(); },
    r => { r.result.conductor.runner.receipts[0].exit_code = 7; },
    r => { r.result.conductor.runner.conditionReceipts.at(-1).exit_code = 7; },
    r => {
      r.result.conductor.expectedOperations = 2;
      r.result.conductor.execution.operations_applied = 2;
      r.result.conductor.toolOutputs.execution = JSON.stringify({
        ...JSON.parse(r.result.conductor.toolOutputs.execution), operations_applied: 2,
      });
    }]) {
    const tampered = structuredClone(record); change(tampered);
    const reference = await retainEvidence(f.directory, tampered);
    await assert.rejects(authenticateTaskEvidence(f.directory, reference, f.args.task));
  }
});

test('BLOCKED missing executable repairs forward with empty operations and authenticated commit', integration, async t => {
  const f = await fixture(t);
  f.args.checks = [{ name: 'environment check', command: [process.execPath, '-e', 'console.log("environment ready")'] }, ...f.args.checks];
  const broken = { ...f.args, checks: [{ ...f.args.checks[0], command: ['pi-test-missing-shell-ENOENT'] }, f.args.checks[1]] };
  const first = await executeAndCheckpoint(broken, f.context);
  assert.equal(first.status, 'BLOCKED', JSON.stringify(first));
  assert.equal(await readFile(path.join(f.directory, 'source.txt'), 'utf8'), 'after');
  assert.equal(f.git('rev-parse', 'HEAD'), f.base);
  const recovered = await inspectIssueAttempt({ reference: first.evidence.reference }, f.context);
  assert.equal(recovered.ok, true, JSON.stringify(recovered)); assert.equal(recovered.matches_source, true);
  const correction = { ...recovered.continuation, input: '{"operations":[]}', checks: f.args.checks };
  const noReason = await executeAndCheckpoint(correction, f.context);
  assert.equal(noReason.status, 'BLOCKED'); assert.match(noReason.message, /verificationRepairReason/);
  assert.equal(noReason.evidence, undefined, 'invalid repairs do not consume an attempt');
  const reason = 'Missing shell executable; invoke the same targeted regression directly with Node, preserving coverage';
  process.env.EXPECTED_REVIEW_REQUIREMENTS = '*';
  const delivered = await executeAndCheckpoint({ ...correction, verificationRepairReason: reason }, f.context);
  assert.equal(delivered.status, 'PASSED', JSON.stringify(delivered)); assert.equal(delivered.stage, 'COMMITTED');
  assert.equal(delivered.evidence.attempt, 2); assert.equal(f.confirmations(), 1);
  const record = await authenticateTaskEvidence(f.directory, delivered.evidence.reference, f.args.task);
  assert.equal(record.args.requirements, f.args.requirements);
  assert.equal(record.args.baseRef, f.base); assert.equal(record.args.previousAttempt, first.evidence.reference);
  assert.match(record.workflow.inputs.requirements, /Missing shell executable/);
  assert.match(record.workflow.inputs.requirements, /Current verification plan/);
  const chain = await authenticateAttemptChain(f.directory, delivered.evidence.reference, f.args.task);
  assert.deepEqual(chain.records.map(r => r.attempt), [1, 2]);
  assert.deepEqual(JSON.parse(record.args.input).operations, []);
  assert.equal(f.git('rev-list', '--count', f.base + '..HEAD'), '1');
  const unaudited = structuredClone(record); delete unaudited.args.verificationRepairReason;
  const unauditedRef = await retainEvidence(f.directory, unaudited);
  await assert.rejects(authenticateAttemptChain(f.directory, unauditedRef, f.args.task), /Invalid correction receipt chain/);
});

test('failed test patches current source with unchanged checks after lifecycle retry', integration, async t => {
  const f = await fixture(t);
  const checks = [{ name: 'source regression', command: [process.execPath, '-e',
    'require("node:assert/strict").equal(require("fs").readFileSync("source.txt","utf8"),"corrected");console.log("1 test passed")'] }];
  const first = await executeAndCheckpoint({ ...f.args, checks }, f.context);
  assert.equal(first.status, 'NEEDS_DESIGN', JSON.stringify(first));
  await f.call('fail', { task_id: 'F', reason: 'Regression assertion failed; retain implementation and receipt' });
  await f.call('retry', { task_id: 'F', reason: 'Correct current source using retained attempt one' });
  await f.call('start', { task_id: 'F' });
  const latest = await inspectIssueAttempt({ reference: first.evidence.reference }, f.context);
  const input = JSON.stringify({ operations: [{ type: 'edit_file', path: 'source.txt', edits: [{ oldText: 'after', newText: 'corrected' }] }] });
  await writeFile(path.join(f.directory, 'unrelated.txt'), 'unretained change');
  const drift = await executeAndCheckpoint({ ...latest.continuation, input }, f.context);
  assert.equal(drift.status, 'BLOCKED'); assert.match(drift.message, /source\/index or HEAD/);
  await rm(path.join(f.directory, 'unrelated.txt'));
  f.git('add', 'source.txt');
  const staged = await executeAndCheckpoint({ ...latest.continuation, input }, f.context);
  assert.equal(staged.status, 'BLOCKED'); assert.match(staged.message, /source\/index or HEAD/);
  f.git('restore', '--staged', 'source.txt');
  const delivered = await executeAndCheckpoint({ ...latest.continuation, input }, f.context);
  assert.equal(delivered.status, 'PASSED', JSON.stringify(delivered)); assert.equal(delivered.evidence.attempt, 2);
  assert.equal(await readFile(path.join(f.directory, 'source.txt'), 'utf8'), 'corrected');
  const record = await authenticateTaskEvidence(f.directory, delivered.evidence.reference, f.args.task);
  assert.deepEqual(record.args.checks, checks); assert.equal(record.args.baseRef, f.base);
  assert.equal(f.confirmations(), 1);
});

test('BLOCKED review resumes from retained tree without reapplying successful operations', integration, async t => {
  const f = await fixture(t); process.env.REVIEW_FIXTURE_STATUS = 'INDETERMINATE';
  const first = await executeAndCheckpoint(f.args, f.context);
  assert.equal(first.status, 'BLOCKED', JSON.stringify(first));
  process.env.REVIEW_FIXTURE_STATUS = 'APPROVED';
  const latest = await inspectIssueAttempt({ reference: first.evidence.reference }, f.context);
  const delivered = await executeAndCheckpoint({ ...latest.continuation, input: '{"operations":[]}' }, f.context);
  assert.equal(delivered.status, 'PASSED', JSON.stringify(delivered)); assert.equal(delivered.evidence.attempt, 2);
  await authenticateTaskEvidence(f.directory, delivered.evidence.reference, f.args.task);
  assert.equal(f.confirmations(), 1);
});

test('invalid workflow preparation does not consume the first task attempt', integration, async t => {
  const f = await fixture(t);
  const invalid = await executeAndCheckpoint({ ...f.args, workflowTimeoutMs: 0 }, f.context, {
    invokeConductor: () => assert.fail('invalid preparation must not invoke Conductor'),
  });
  assert.equal(invalid.status, 'BLOCKED');
  const delivered = await executeAndCheckpoint(f.args, f.context, {
    invokeConductor: body => f.finalCommand(body),
  });
  assert.equal(delivered.status, 'PASSED', JSON.stringify(delivered));
  assert.equal(delivered.evidence.attempt, 1);
});

test('a retained check condition can accept a nonzero command and authorize the same in-list commit', integration, async t => {
  const f = await fixture(t);
  f.args.checks = [{ name: 'semantic check', command: [process.execPath, '-e', 'console.log("validated");process.exit(7)'],
    successCondition: [process.execPath, '-e',
      'const fs=require("fs");process.exit(process.env.CONDUCTOR_COMMAND_EXIT_CODE==="7" && fs.readFileSync(process.env.CONDUCTOR_COMMAND_STDOUT_PATH,"utf8").includes("validated")?0:1)'] }];
  const result = await executeAndCheckpoint(f.args, f.context, { invokeConductor: body => f.finalCommand(body) });
  assert.equal(result.status, 'PASSED', JSON.stringify(result));
  assert.equal(result.stage, 'COMMITTED');
  const record = await readEvidence(f.directory, result.evidence.reference);
  assert.equal(record.result.conductor.checks[0].exit_code, 7);
  assert.equal(record.result.conductor.checks[0].condition.status, 'PASSED');
});

test('a retained check condition rejects a zero-exit command before Review and commit', integration, async t => {
  const f = await fixture(t);
  f.args.checks = [{ name: 'semantic check', command: [process.execPath, '-e', 'console.log("tests failed")'],
    successCondition: [process.execPath, '-e',
      'const fs=require("fs");process.exit(fs.readFileSync(process.env.CONDUCTOR_COMMAND_STDOUT_PATH,"utf8").includes("failed")?1:0)'] }];
  const result = await executeAndCheckpoint(f.args, f.context, { invokeConductor: body => f.finalCommand(body) });
  assert.notEqual(result.stage, 'COMMITTED');
  assert.equal(f.git('rev-parse', 'HEAD'), f.base);
  assert.equal(await readFile(path.join(f.directory, '.git/trace'), 'utf8'), 'executor\n');
});

test('preparation failure after STARTED retains terminal evidence for a correction', integration, async t => {
  const f = await fixture(t);
  const runs = path.join(f.directory, '.git', 'pi-conductor-runs');
  await symlink(path.join(f.directory, '.git'), runs);
  const blocked = await executeAndCheckpoint(f.args, f.context, {
    invokeConductor: () => assert.fail('unsafe output directory must stop preparation'),
  });
  assert.equal(blocked.status, 'BLOCKED');
  assert.equal(blocked.evidence?.attempt, 1);
  const record = await readEvidence(f.directory, blocked.evidence.reference);
  assert.equal(record.startedReference != null, true);
  await rm(runs);
  const corrected = await executeAndCheckpoint({ ...f.args, previousAttempt: blocked.evidence.reference }, f.context,
    { invokeConductor: body => f.finalCommand(body) });
  assert.equal(corrected.status, 'PASSED', JSON.stringify(corrected));
  assert.equal(corrected.evidence.attempt, 2);
});

test('a check that changes retained review criteria or baseline prevents commit', integration, async t => {
  for (const kind of ['requirements', 'review']) await t.test(kind, async t => {
    const f = await fixture(t);
    const mutation = kind === 'requirements'
      ? 'fs.writeFileSync(path.join(root, "requirements.md"), "weakened")'
      : 'fs.writeFileSync(path.join(root, "review.json"), JSON.stringify({...JSON.parse(fs.readFileSync(path.join(root, "review.json"))), base_ref:"wrong"}))';
    f.args.checks = [{ name: 'tampering check', command: [process.execPath, '-e',
      'const fs=require("fs"),path=require("path");' +
      'const root=path.join(".git", "pi-conductor-runs", fs.readdirSync(path.join(".git", "pi-conductor-runs")).find(x=>x.startsWith("attempt-")));' +
      mutation] }];
    const result = await executeAndCheckpoint(f.args, f.context, { invokeConductor: body => f.finalCommand(body) });
    assert.notEqual(result.stage, 'COMMITTED');
    assert.equal(f.git('rev-parse', 'HEAD'), f.base);
    assert.equal((await f.call('list')).feature.tasks.F.status, 'in_progress');
    assert.equal(await readFile(path.join(f.directory, '.git/trace'), 'utf8'), 'executor\n');
  });
});

test('failed checks, rejected review and indeterminate review never run the commit stage', integration, async t => {
  for (const mode of ['CHANGES_REQUESTED', 'INDETERMINATE', 'FAILED_CHECK']) await t.test(mode, async t => {
    const f = await fixture(t);
    process.env.REVIEW_FIXTURE_STATUS = mode;
    if (mode === 'FAILED_CHECK') f.args.checks[0].command = [process.execPath, '-e', 'process.exit(7)'];
    const result = await executeAndCheckpoint(f.args, f.context);
    assert.equal(result.status, mode === 'INDETERMINATE' ? 'BLOCKED' : 'NEEDS_DESIGN', JSON.stringify(result));
    assert.equal(f.git('rev-parse', 'HEAD'), f.base);
    assert.equal((await f.call('list')).feature.tasks.F.status, 'in_progress');
    const record = await readEvidence(f.directory, result.evidence.reference);
    const actualRunner = JSON.parse(record.response.stdout);
    assert.equal(actualRunner.commands.some(c => c.name === 'git commit verified task'), false);
    assert.equal(record.deliveryRequest.commands.at(-1).name, 'git commit verified task');
  });
});

test('commit failure keeps successful evidence and retries without reapplying or reviewing', integration, async t => {
  const f = await fixture(t);
  const lock = path.join(f.directory, '.git/index.lock');
  const result = await executeAndCheckpoint(f.args, f.context, { invokeConductor: async body => {
    process.env.REVIEW_FIXTURE_LOCK = '1'; return f.finalCommand(body);
  } });
  assert.equal(result.status, 'BLOCKED', JSON.stringify(result));
  assert.equal(result.implementationStatus, 'PASSED');
  assert.equal(f.git('rev-parse', 'HEAD'), f.base);
  assert.equal((await f.call('list')).feature.tasks.F.status, 'completed');
  await rm(lock);
  delete process.env.REVIEW_FIXTURE_LOCK;
  const recovered = await finalizeVerifiedTask(f.finalizeArgs(result), f.context);
  assert.equal(recovered.ok, true, JSON.stringify(recovered));
  assert.equal(f.git('rev-list', '--count', f.base + '..HEAD'), '1');
  assert.equal(await readFile(path.join(f.directory, '.git/trace'), 'utf8'), 'executor\ncheck\nreview\n');
});

test('lost commit response recovers the same commit without duplicates', integration, async t => {
  const f = await fixture(t);
  const result = await executeAndCheckpoint(f.args, f.context, { invokeConductor: async body => {
    await f.finalCommand(body); throw new Error('Lost commit response');
  } });
  assert.equal(result.status, 'BLOCKED'); assert.equal(result.implementationStatus, 'PASSED');
  const commit = f.git('rev-parse', 'HEAD'); assert.notEqual(commit, f.base);
  const recovered = await finalizeVerifiedTask(f.finalizeArgs(result), f.context);
  assert.equal(recovered.ok, true, JSON.stringify(recovered));
  assert.equal(recovered.recovered, true); assert.equal(recovered.commit, commit);
  assert.equal(f.git('rev-list', '--count', f.base + '..HEAD'), '1');
});

test('failed completion recording can resume finalization without reapplying', integration, async t => {
  const f = await fixture(t);
  const previous = process.env.FAIL_SCAFFOLD_COMPLETE;
  t.after(() => { if (previous === undefined) delete process.env.FAIL_SCAFFOLD_COMPLETE; else process.env.FAIL_SCAFFOLD_COMPLETE = previous; });
  const result = await executeAndCheckpoint(f.args, f.context, { invokeConductor: async body => {
    process.env.FAIL_SCAFFOLD_COMPLETE = '1'; return f.finalCommand(body);
  } });
  assert.equal(result.status, 'BLOCKED'); assert.equal(result.implementationStatus, 'PASSED');
  assert.equal((await f.call('list')).feature.tasks.F.status, 'in_progress');
  assert.equal(f.git('rev-parse', 'HEAD'), f.base);
  delete process.env.FAIL_SCAFFOLD_COMPLETE;
  const recovered = await finalizeVerifiedTask(f.finalizeArgs(result), f.context);
  assert.equal(recovered.ok, true, JSON.stringify(recovered));
  assert.equal(f.git('rev-list', '--count', f.base + '..HEAD'), '1');
  assert.equal(await readFile(path.join(f.directory, '.git/trace'), 'utf8'), 'executor\ncheck\nreview\n');
});

test('source drift before commit and missing/protected checkpoint context fail closed', integration, async t => {
  const f = await fixture(t);
  for (const checkpoint of [undefined, { defaultBranch: 'main' }, { defaultBranch: 'main', protectedBranches: ['feature/automatic'] }]) {
    const result = await executeAndCheckpoint({ ...f.args, checkpoint }, f.context);
    assert.equal(result.status, 'BLOCKED');
    await assert.rejects(readFile(path.join(f.directory, '.git/trace')), { code: 'ENOENT' });
  }
  const drift = await executeAndCheckpoint(f.args, f.context, { invokeConductor: async body => {
    process.env.REVIEW_FIXTURE_DRIFT = '1'; return f.finalCommand(body);
  } });
  assert.equal(drift.status, 'BLOCKED', JSON.stringify(drift));
  assert.equal(f.git('rev-parse', 'HEAD'), f.base);
  assert.equal((await f.call('list')).feature.tasks.F.status, 'in_progress');
});

// The final command may be reached after an exit-0 Review, but must still reject
// malformed JSON or tampered command receipts before any Git commit/state change.
test('single-list commit gate rejects malformed Review output and tampered process receipts', integration, async t => {
  for (const mode of ['REVIEW_FIXTURE_MALFORMED', 'REVIEW_FIXTURE_TAMPER']) await t.test(mode, async t => {
    const f = await fixture(t); process.env[mode] = '1';
    const result = await executeAndCheckpoint(f.args, f.context);
    assert.equal(result.status, 'BLOCKED', JSON.stringify(result));
    assert.equal(f.git('rev-parse', 'HEAD'), f.base);
    assert.equal((await f.call('list')).feature.tasks.F.status, 'in_progress');
  });
});

test('an existing terminal receipt claim blocks commit without competing success/failure records', integration, async t => {
  const f = await fixture(t); process.env.REVIEW_FIXTURE_TERMINAL_LOCK = '1';
  const result = await executeAndCheckpoint(f.args, f.context);
  assert.equal(result.status, 'BLOCKED', JSON.stringify(result));
  assert.equal(result.reason, 'TERMINAL_RECEIPT_PENDING');
  assert.equal(result.implementationStatus, undefined);
  assert.equal(f.git('rev-parse', 'HEAD'), f.base);
  assert.equal((await f.call('list')).feature.tasks.F.status, 'in_progress');
  const record = await readEvidence(f.directory, result.evidence.reference);
  assert.equal(record.result.stage, 'STARTED');
  const records = (await readdir(path.join(f.directory, '.git/pi-conductor-evidence'))).filter(x => /^[a-f0-9]{64}\.json$/.test(x));
  assert.equal(records.length, 1);
});

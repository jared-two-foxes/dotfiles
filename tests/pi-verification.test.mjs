import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { executeAndReview } from '../pi/agent/extensions/conductor/adapter.mjs';
import { inspectEvidence, readEvidence, retainEvidence } from '../pi/agent/extensions/conductor/evidence.mjs';
import { authenticateTaskEvidence } from '../pi/agent/extensions/conductor/checkpoint.mjs';

async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'pi-selected-verification-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
  await writeFile(path.join(dir, 'source.txt'), 'before'); git('add', '.'); git('commit', '-qm', 'baseline');
  const args = { input: '{"operations":[]}', baseRef: git('rev-parse', 'HEAD'), requirements: 'Scoped change',
    task: { featureId: 'F', taskId: 'T', designRef: 'approved@1' },
    checks: [
      { name: 'compile', command: [process.execPath, '-e', 'console.log("compiled")'] },
      { name: 'invoice tests', command: [process.execPath, '-e', 'console.log("3 invoice tests passed")'] },
      { name: 'client tests', command: [process.execPath, '-e', 'console.log("2 client tests passed")'] },
    ] };
  return { dir, args };
}

// Run the real argv commands and final snapshot wrapper, substituting only the
// unavailable Rust executor/reviewer. No live model or project test suite needed.
async function respond(json, patch = {}) {
  const request = JSON.parse(json);
  const checks = [];
  for (const check of request.checks) {
    let exit_code = 0, stdout = '', stderr = '';
    try { stdout = execFileSync(check.program, check.args, { cwd: request.repository_path, encoding: 'utf8' }); }
    catch (error) { exit_code = error.status; stdout = error.stdout; stderr = error.stderr; }
    checks.push({ name: check.name, program: check.program, exit_code, stdout, stderr });
    if (exit_code !== 0) return { code: 2, stdout: JSON.stringify({ schema: 'conductor.result/v1',
      status: 'NEEDS_DESIGN', phase: 'verification', execution: { success: true }, checks, review: null }), stderr: '' };
  }
  return { code: 0, stderr: '', stdout: JSON.stringify({ schema: 'conductor.result/v1',
    status: 'PASSED', phase: 'review', execution: { success: true }, checks, review: { status: 'APPROVED' }, ...patch }) };
}

test('forwards named commands in order without build/test defaults or shell interpretation', async t => {
  const f = await fixture(t);
  delete f.args.task;
  f.args.checks = [{ name: 'filtered Rust tests', command: ['cargo', 'test', '--lib', 'invoices::', '--', '--exact'] },
    { name: 'literal arguments', command: ['tool', 'a b', '$(do-not-execute)', ';'] }];
  let calls = 0;
  const result = await executeAndReview(f.args, { directory: f.dir }, { invokeConductor: async json => {
    calls++;
    assert.deepEqual(JSON.parse(json).checks, f.args.checks.map(c => ({ name: c.name, program: c.command[0], args: c.command.slice(1) })));
    return { code: 2, stdout: JSON.stringify({ schema: 'conductor.result/v1', status: 'NEEDS_DESIGN', phase: 'verification' }) };
  } });
  assert.equal(result.status, 'NEEDS_DESIGN'); assert.equal(calls, 1);
});

test('invalid, empty, duplicate and ambiguous plans block before invocation or receipt creation', async t => {
  const f = await fixture(t);
  for (const checks of [null, [], {}, Array(65).fill(f.args.checks[0]), [{ name: ' ' , command: ['true'] }],
    [{ name: 'duplicate', command: ['true'] }, { name: 'duplicate', command: ['true'] }],
    [{ name: 'test', command: [] }], [{ name: 'test', command: [' '] }],
    [{ name: 'test', command: ['tool', '\0'] }], [{ name: 'test', command: ['tool'], timeoutMs: 1 }]]) {
    const result = await executeAndReview({ ...f.args, checks }, { directory: f.dir }, {
      invokeConductor: () => assert.fail('invalid plan must not invoke'),
    });
    assert.equal(result.status, 'BLOCKED'); assert.equal(result.evidence, undefined);
  }
  for (const patch of [{ buildCommand: ['build'] }, { testCommand: ['test'] }, { buildCommand: ['build'], testCommand: ['test'] }]) {
    const result = await executeAndReview({ ...f.args, ...patch }, { directory: f.dir }, {
      invokeConductor: () => assert.fail('mixed interfaces must not invoke'),
    });
    assert.equal(result.status, 'BLOCKED'); assert.match(result.message, /not both/);
  }
});

test('task receipts authenticate every selected check and snapshot only after the last check', async t => {
  for (const single of [false, true]) {
    const f = await fixture(t);
    if (single) f.args.checks = f.args.checks.slice(-1);
    const result = await executeAndReview(f.args, { directory: f.dir }, { invokeConductor: async json => {
      const request = JSON.parse(json);
      for (let i = 0; i < request.checks.length - 1; i++) {
        assert.deepEqual(request.checks[i], { name: f.args.checks[i].name,
          program: f.args.checks[i].command[0], args: f.args.checks[i].command.slice(1) });
      }
      const boundary = JSON.parse(request.checks.at(-1).args[1]);
      assert.deepEqual(boundary.command, f.args.checks.at(-1).command);
      return respond(json);
    } });
    assert.equal(result.status, 'PASSED', JSON.stringify(result));
    const evidence = await inspectEvidence(result.evidence.reference, { directory: f.dir });
    assert.equal(evidence.structurallyVerified, true);
    assert.deepEqual(evidence.record.args.checks, f.args.checks);
    assert.equal(evidence.record.reviewSnapshot.digest, evidence.record.after.digest);
    assert.equal((await authenticateTaskEvidence(f.dir, result.evidence.reference, f.args.task)).attempt, 1);
    assert.match(result.conductor.checks.at(-1).stdout, /client tests passed/);
    const altered = await retainEvidence(f.dir, { ...evidence.record,
      args: { ...f.args, checks: f.args.checks.map((c, i) => i ? c : { ...c, command: ['true'] }) },
    });
    await assert.rejects(authenticateTaskEvidence(f.dir, altered, f.args.task), /plan mismatch/);

    for (const [caseIndex, checks] of [[], result.conductor.checks.slice(1),
      ...(single ? [] : [[...result.conductor.checks].reverse()]),
      [...result.conductor.checks, result.conductor.checks[0]],
      result.conductor.checks.map((c, i) => i === 0 ? { ...c, exit_code: 1 } : c)].entries()) {
      const forged = await retainEvidence(f.dir, { ...evidence.record, recordedAt: 'invalid-result-' + caseIndex,
        result: { ...result, conductor: { ...result.conductor, checks } } });
      await assert.rejects(authenticateTaskEvidence(f.dir, forged, f.args.task));
    }
  }
});

test('corrections retain the complete ordered plan and reject scope changes', async t => {
  const f = await fixture(t);
  const first = await executeAndReview(f.args, { directory: f.dir }, { invokeConductor: async json =>
    ({ ...(await respond(json)), code: 2, stdout: JSON.stringify({ schema: 'conductor.result/v1', status: 'NEEDS_DESIGN', phase: 'review' }) }) });
  assert.equal(first.status, 'NEEDS_DESIGN');
  for (const checks of [f.args.checks.slice(1), [...f.args.checks].reverse(),
    f.args.checks.map((c, i) => i ? c : { ...c, command: ['true'] }),
    f.args.checks.map((c, i) => i ? c : { ...c, name: 'renamed' })]) {
    const result = await executeAndReview({ ...f.args, checks, previousAttempt: first.evidence.reference }, { directory: f.dir }, {
      invokeConductor: () => assert.fail('changed plan must not invoke'),
    });
    assert.equal(result.status, 'BLOCKED'); assert.match(result.message, /Previous attempt/);
  }
  const corrected = await executeAndReview({ ...f.args, previousAttempt: first.evidence.reference }, { directory: f.dir }, { invokeConductor: respond });
  assert.equal(corrected.status, 'PASSED'); assert.equal(corrected.evidence.attempt, 2);
  await authenticateTaskEvidence(f.dir, corrected.evidence.reference, f.args.task);
});

test('failed checks stop later verification and cannot produce successful evidence', async t => {
  const f = await fixture(t);
  f.args.checks[1].command = [process.execPath, '-e', 'process.exit(7)'];
  f.args.checks[2].command = [process.execPath, '-e', 'require("fs").writeFileSync("must-not-run", "bad")'];
  const result = await executeAndReview(f.args, { directory: f.dir }, { invokeConductor: respond });
  assert.equal(result.status, 'NEEDS_DESIGN'); assert.equal(result.conductor.checks.length, 2);
  assert.equal(result.conductor.checks[1].exit_code, 7);
  await assert.rejects(readFile(path.join(f.dir, 'must-not-run')));
  assert.equal((await inspectEvidence(result.evidence.reference, { directory: f.dir })).structurallyVerified, false);
});

test('source changes after the final selected check invalidate the review snapshot', async t => {
  const f = await fixture(t);
  const result = await executeAndReview(f.args, { directory: f.dir }, { invokeConductor: async json => {
    const response = await respond(json);
    await writeFile(path.join(f.dir, 'source.txt'), 'drift during review');
    return response;
  } });
  assert.equal(result.status, 'BLOCKED'); assert.equal(result.reason, 'REVIEW_SNAPSHOT_CHANGED');
  const receipt = await readEvidence(f.dir, result.evidence.reference);
  assert.notEqual(receipt.reviewSnapshot.digest, receipt.after.digest);
});

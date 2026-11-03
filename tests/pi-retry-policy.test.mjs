import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diagnosticSignature, stallDecision, infrastructureDecision, failureObservation } from '../pi/agent/extensions/conductor/retry-policy.mjs';
import { updateContext, obligationsVerified, renderContext, validContextContinuation } from '../pi/agent/extensions/conductor/delivery-context.mjs';
const checks = [{ name: 'regression', command: ['cargo', 'test', 'status'], successCondition: ['validate-results'] }];
const context = () => ({ original: 'Reject invalid statuses', design: { reference: 'design', summary: 'Validate imports', verification: 'Regression', approval: 'direction' }, updates: [], obligations: [] });
const record = (category, n, diagnostic = 'same error', tree = 'a') => ({ startedReference: 'intent-' + n,
  recordedAt: new Date(1000 * n).toISOString(), after: { tree }, args: { reviewEnvironment: 'env', checks },
  result: { status: 'NEEDS_DESIGN', conductor: category === 'review' ? { phase: 'review', checks: [],
    review: { status: 'CHANGES_REQUESTED', reason: 'REVIEW_COMPLETED', findings: [{ blocking: true, path: 'status.rs', message: diagnostic }] } } :
    { phase: 'verification', checks: [{ name: 'regression', status: 'FAILED', exit_code: 1, stderr: diagnostic }] } } });

test('stall signatures remove timing noise, preserve substantive diagnostics and detect recurring trees', () => {
  assert.equal(diagnosticSignature('E0308 mismatch 10ms'), diagnosticSignature('E0308 mismatch 90ms'));
  assert.notEqual(diagnosticSignature('E0308 mismatch'), diagnosticSignature('E0412 missing type'));
  assert.equal(stallDecision([record('test', 1), record('test', 2)], { input: '{"operations":[]}' }), null);
  assert.equal(stallDecision([1, 2, 3].map(n => record('test', n)), {}).reason, 'DIAGNOSIS_REQUIRED');
  assert.equal(stallDecision([record('test', 1, 'a', 'A'), record('test', 2, 'b', 'B'),
    record('test', 3, 'a', 'A'), record('test', 4, 'b', 'B')], {}).reason, 'DIAGNOSIS_REQUIRED');
  assert.equal(stallDecision([record('test', 1, 'compile'), record('test', 2, 'test'), record('review', 3, 'status finding')], {}), null);
});

test('infrastructure circuits require relevant repair and resource pauses retain their distinct reason', () => {
  const r = record('review', 1); r.result.conductor.review = { status: 'INDETERMINATE', reason: 'AUTHENTICATION_FAILURE' };
  assert.equal(infrastructureDecision([r], 'env', 1000000).reason, 'INFRASTRUCTURE_PAUSED');
  assert.equal(infrastructureDecision([r], 'repaired', 1000000), null);
  r.result.conductor.review.reason = 'NETWORK_FAILURE';
  assert.equal(infrastructureDecision([r], 'env', 2000).reason, 'INFRASTRUCTURE_PAUSED');
  assert.equal(infrastructureDecision([r], 'env', 302000), null);
  r.result.conductor.review.reason = 'BUDGET_EXHAUSTED';
  assert.equal(infrastructureDecision([r], 'env', 900000).reason, 'RESOURCE_PAUSED');
});

test('structured revisions retain originals; authors cannot verify or remove obligations', () => {
  const c = context();
  const update = { kind: 'add_obligation', id: 'quote-status', text: 'Add invalid-status regression', reason: 'Independent finding' };
  const revised = updateContext(c, [update], checks);
  const proposed = updateContext(revised.context, [{ kind: 'propose_addressed', findingId: 'quote-status', reason: 'Implemented regression' }], checks);
  assert.equal(proposed.context.original, c.original);
  assert.equal(obligationsVerified({ deliveryContext: proposed.context }, { status: 'APPROVED' }), false);
  assert.equal(obligationsVerified({ deliveryContext: proposed.context }, { obligation_assessments: [
    { obligation_id: 'quote-status', disposition: 'verified', evidence: 'Inspected status.rs and passing import regression' }] }), true);
  for (const kind of ['remove_obligation', 'weaken_contract']) assert.throws(() =>
    updateContext(c, [{ kind, reason: 'Avoid failure' }], checks), /approved design transition/);
  const old = { args: { deliveryContext: c, requirements: renderContext(c) } };
  assert.equal(validContextContinuation(old, { deliveryContext: proposed.context, requirements: renderContext(proposed.context) }), true);
  proposed.context.original = 'Accept all statuses';
  assert.equal(validContextContinuation(old, { deliveryContext: proposed.context, requirements: renderContext(proposed.context) }), false);
});

test('zero-selection filter repair retains semantic validator and records coverage justification', () => {
  const u = { kind: 'repair_check', checkId: 'regression', command: ['cargo', 'test', 'import_status'], reason: 'Old exact filter selected zero tests; this exercises the required import regression' };
  const revised = updateContext(context(), [u], checks);
  assert.deepEqual(revised.checks[0].successCondition, ['validate-results']);
  assert.deepEqual(revised.checks[0].command, u.command);
  assert.throws(() => updateContext(context(), [{ ...u, successCondition: ['true'] }], checks));
});

test('recognized Cargo test selection requires positive completed tests, including after a filter repair', async t => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const dir = await mkdtemp(path.join(tmpdir(), 'pi-meaningful-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const out = path.join(dir, 'stdout'), err = path.join(dir, 'stderr'); await writeFile(err, '');
  const { fileURLToPath } = await import('node:url');
  const validator = new URL('../pi/agent/extensions/conductor/meaningful-test-condition.mjs', import.meta.url);
  for (const [output, expected] of [['test result: ok. 0 passed; 0 failed', 1],
    ['running 2 tests', 1], ['test result: ok. 2 passed; 0 failed\ntest result: ok. 0 passed', 0]]) {
    await writeFile(out, output);
    const r = spawnSync(process.execPath, [fileURLToPath(validator)], { env: { ...process.env,
      CONDUCTOR_COMMAND_EXIT_CODE: '0', CONDUCTOR_COMMAND_STDOUT_PATH: out, CONDUCTOR_COMMAND_STDERR_PATH: err } });
    assert.equal(r.status, expected, r.stderr.toString());
  }
});


test('compiler diagnostics emitted by a test runner remain compilation failures', () => {
  assert.equal(failureObservation(record('test', 1, 'error[E0308]: mismatched types')).category, 'compile');
  assert.equal(failureObservation(record('test', 2, 'assertion failed: imported status was accepted')).category, 'test');
});

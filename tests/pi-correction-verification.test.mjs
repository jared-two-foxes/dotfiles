import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { correctionVerification, meaningfulTestEvaluator } from '../pi/agent/extensions/delivery-state/verification.mjs';

test('explicit invocation repair retains names/order and semantic conditions for every check', () => {
  const checks = [{ name: 'compile', command: ['cargo', 'check'] },
    { name: 'regression', command: ['sh', '-c', 'cargo test --test regression'], successCondition: ['validate-results'] }];
  const previous = { args: { checks }, result: { status: 'BLOCKED' } };
  const changed = structuredClone(checks);
  changed[1].command = ['cargo', 'test', '--test', 'regression'];
  const repair = { checks: changed, verificationRepairReason: 'Invoke Cargo directly because sh is not installed; same regression target' };
  assert.equal(correctionVerification(previous, { checks }), true);
  assert.equal(correctionVerification(previous, { checks: changed }), false);
  assert.equal(correctionVerification(previous, repair), true);
  for (const reason of ['', ' ', 3, 'bad\0reason', 'x'.repeat(4001)])
    assert.equal(correctionVerification(previous, { ...repair, verificationRepairReason: reason }), false);
  for (const alter of [c => c.pop(), c => c.reverse(), c => { c[1].name = 'other'; },
    c => { delete c[1].successCondition; }, c => { c[1].successCondition = ['true']; }]) {
    const checks = structuredClone(changed); alter(checks);
    assert.equal(correctionVerification(previous, { ...repair, checks }), false);
  }
  assert.equal(correctionVerification({ ...previous, result: { status: 'PASSED' } }, repair), false);
  assert.equal(correctionVerification({ ...previous, result: { status: 'NEEDS_DESIGN' } }, repair), true);
});

test('evaluator repair requires a redesigned issue handoff and the canonical validator for the same command', () => {
  const command = ['cargo', 'test', '--test', 'cli', 'quote_activity'];
  const check = { name: 'CLI', command, successCondition: ['quote.created', 'quote.item_added'] };
  const previous = {
    kind: 'issue-handoff', task: { taskId: 'cli' },
    args: { checks: [check], deliveryContext: { design: { reference: 'old' } } },
    result: { status: 'BLOCKED', reason: 'ISSUE_RECOVERY_READY' },
    recovery: { feature: { tasks: { cli: { designs: [{ reference: 'approved' }] } } } },
  };
  const repaired = {
    checks: [{ ...check, successCondition: meaningfulTestEvaluator(command) }],
    deliveryContext: { design: { reference: 'approved' } },
    contextUpdates: [{ kind: 'repair_check', checkId: 'CLI', useMeaningfulTestEvaluator: true, reason: 'Invalid evaluator argv' }],
  };
  assert.equal(correctionVerification(previous, repaired), true);
  const legacy = structuredClone(repaired);
  legacy.checks[0].successCondition[1] = fileURLToPath(
    new URL('../pi/agent/extensions/conductor/meaningful-test-condition.mjs', import.meta.url),
  );
  assert.equal(correctionVerification(previous, legacy), true);
  assert.equal(correctionVerification({ ...previous, kind: 'rebase-handoff' }, repaired), false);
  assert.equal(correctionVerification(previous, { ...repaired, contextUpdates: [] }), false);
  for (const alter of [
    args => { args.deliveryContext.design.reference = 'old'; },
    args => { args.checks[0].command = ['cargo', 'test']; },
    args => { args.checks[0].successCondition = ['true']; },
    args => { delete args.checks[0].successCondition; },
  ]) {
    const args = structuredClone(repaired);
    alter(args);
    assert.equal(correctionVerification(previous, args), false);
  }
});

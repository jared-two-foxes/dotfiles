import { validContextContinuation } from '../delivery-state/delivery-context.mjs';
import { rebasedAttemptTree } from '../git/recovery-tree.mjs';
// Authenticate correction epochs and explicit rebase bridges without resetting attempts.
import { isDeepStrictEqual as equal } from 'node:util';
import { git } from '../git/tree.mjs';
import { readEvidence } from '../evidence/store.mjs';
import { scaffoldCall } from '../scaffold/client.mjs';
import { featureInstanceId } from './feature-instance.mjs';
import { validateBinding } from '../delivery-state/binding.mjs';
import { sameVerification, correctionVerification } from './checks.mjs';
import { verifyHistory } from './history.mjs';
const requireValue = (ok, message) => { if (!ok) throw new Error(message); };
const sha = x => /^[a-f0-9]{40}$/.test(x ?? '');

export function carriedRequirements(requirements, records) {
  const findings = records.filter(r => !['rebase-handoff', 'issue-handoff'].includes(r.kind)).map(r => {
    const conductor = r.result.conductor ?? r.result.actualResult?.conductor;
    return { attempt: r.attempt, baseline: r.args.baseRef, status: r.result.status,
      stage: r.result.stage, reason: r.result.reason, message: r.result.message,
      error: conductor?.error, executionError: conductor?.execution?.error,
      review: conductor?.review ?? null,
      checks: conductor?.checks?.map(c => ({ name: c.name, exit_code: c.exit_code, problem: c.problem })) };
  });
  const text = requirements + '\n\nInterrupted issue continuation: preserve all original criteria above. ' +
    'The task is NOT verified. Resolve retained findings and rerun the unchanged task checks. ' +
    'Consumed attempts are not reset. Full original requests/responses and check logs remain in the linked previousAttempt receipts; inspect them when interpreting failures. Retained outcomes and unresolved review findings:\n' + JSON.stringify(findings);
  // Review context allowances are enforced as resumable resource controls at the
  // next invocation, never by stranding a suspended issue or resetting its history.
  return text;
}


// A same-tree failed attempt still consumes budget. The ledger records every terminal attempt of a
// task in sequence, so staleness is a comparison with that list, not a scan of receipt files.
// `reference` may be a terminal receipt or the intent receipt of an attempt that has since finished.
export async function assertLatestAttempt(repository, reference, binding, attempt, options) {
  let feature;
  try {
    feature = (await scaffoldCall(repository, { operation: 'list', feature_id: binding.featureId }, options?.scaffoldOptions)).feature;
  } catch (error) {
    if (error.code === 'UNKNOWN_FEATURE') return; // no open feature, so no recorded attempts
    throw error;
  }
  const recorded = feature.tasks?.[binding.taskId]?.attempts ?? [];
  const stale = () => Object.assign(new Error('A newer task attempt or terminal receipt exists; inspect and use the latest retained evidence without resetting its count'),
    reference ? { code: 'CONTINUATION_RECEIPT_STALE' } : {});
  if (recorded.some(a => a.attempt > attempt)) throw stale();
  const same = recorded.find(a => a.attempt === attempt);
  if (same && reference && same.receipt !== reference) {
    // A handoff that continues the finished attempt keeps its attempt number and is current. The
    // retained *intent* of an attempt that has since finished is not.
    const named = await readEvidence(repository, reference, { featureId: binding.featureId });
    if (named.result?.stage === 'STARTED') throw stale();
  }
}

export async function authenticateAttemptChain(repository, reference, binding, seen = new Set(), pendingReference) {
  requireValue(!seen.has(reference), 'Cyclic or excessive correction/recovery chain'); seen.add(reference);
  validateBinding(binding);
  const record = await readEvidence(repository, reference);
  requireValue(equal(record.task, binding) && equal(record.args?.task, binding) &&
    Number.isInteger(record.attempt) && (record.attempt >= 1 || (record.attempt === 0 && record.kind === 'issue-zero-handoff')) &&
    sha(record.args.baseRef) && record.before?.head === record.args.baseRef && sha(record.after?.head) &&
    (record.after.head === record.args.baseRef || (record.result?.status === 'BLOCKED' && record.result.reason === 'HEAD_CHANGED')) &&
    sha(record.before.tree) && sha(record.after.tree) &&
    typeof record.before.digest === 'string' && typeof record.after.digest === 'string' &&
    ['PASSED', 'NEEDS_DESIGN', 'BLOCKED'].includes(record.result?.status), 'Invalid task correction receipt');
  if (record.kind === 'issue-zero-handoff') {
    const parked = await readEvidence(repository, record.recovery.suspensionRef);
    requireValue(parked.kind === 'issue-suspension' && parked.attempt === 0 && !parked.args.previousAttempt &&
      parked.args.baseRef === parked.before.head && equal(parked.args.task, binding) &&
      record.result.reason === 'ISSUE_RECOVERY_READY' && parked.result.reason === 'ISSUE_SUSPENDED' &&
      record.recovery.feature.tasks[binding.taskId].suspension?.reference === record.recovery.suspensionRef &&
      equal(parked.task, binding) && parked.before.clean && equal(parked.before, parked.after) &&
      !record.args.previousAttempt && record.before.clean && equal(record.before, record.after) &&
      record.before.tree === git(repository, ['rev-parse', record.args.baseRef + '^{tree}']), 'Invalid zero-attempt issue handoff');
    const sourceRef = 'refs/pi-issue-suspensions/' + record.recovery.suspensionRef.split(':').at(-1);
    requireValue(git(repository, ['rev-parse', sourceRef + '^{tree}']) === parked.before.tree &&
      git(repository, ['show', '-s', '--format=%P', sourceRef]) === parked.before.head &&
      git(repository, ['rev-parse', sourceRef + '-index^{tree}']) === parked.before.tree, 'Missing zero-attempt suspension snapshots');
    // The recovery's feature copy was taken at the handoff, when the ledger head was this baseline.
    verifyHistory(repository, record.recovery.feature, { head: record.args.baseRef });
    return { record, records: [record] };
  }
  if (record.kind === 'issue-handoff') {
    const prior = await authenticateAttemptChain(repository, record.args.previousAttempt, binding, seen, pendingReference);
    const previous = prior.record, recovery = record.recovery;
    const parked = await readEvidence(repository, recovery.suspensionRef);
    const { issueDesignRequirements } = await import('../scaffold/contracts.mjs');
    requireValue(parked.kind === 'issue-suspension' && equal(parked.task, binding) &&
      parked.args.previousAttempt === record.args.previousAttempt && equal(parked.after, previous.after) &&
      previous.result.status !== 'PASSED' && previous.attempt === record.attempt &&
      sameVerification(previous.args, record.args) && recovery.feature.design_ref === binding.designRef &&
      recovery.feature.tasks[binding.taskId].suspension?.reference === recovery.suspensionRef &&
      record.args.requirements === carriedRequirements(previous.args.requirements, prior.records) +
        issueDesignRequirements(recovery.feature.tasks[binding.taskId]) &&
      record.result.status === 'BLOCKED' && record.result.reason === 'ISSUE_RECOVERY_READY' &&
      equal(record.before, record.after) && !record.before.bookkeepingVisible &&
      record.before.tree === rebasedAttemptTree(repository, previous, record.args.baseRef).tree,
    'Invalid suspended issue continuation');
    const sourceRef = 'refs/pi-issue-suspensions/' + recovery.suspensionRef.split(':').at(-1);
    requireValue(git(repository, ['rev-parse', sourceRef + '^{tree}']) === parked.after.tree &&
      git(repository, ['show', '-s', '--format=%P', sourceRef]) === previous.args.baseRef,
    'Suspended source snapshot missing or changed');
    const savedIndex = git(repository, ['rev-parse', sourceRef + '-index']);
    requireValue(git(repository, ['rev-parse', savedIndex + '^{tree}']) === parked.suspension.indexTree &&
      recovery.indexTree === git(repository, ['merge-tree', '--write-tree', '--merge-base=' + previous.args.baseRef, record.args.baseRef, savedIndex]).split('\n')[0], 'Issue index handoff mismatch');
    verifyHistory(repository, recovery.feature, { head: record.args.baseRef });
    const records = [...prior.records, record];
    if (reference !== pendingReference) for (const [index, retained] of records.entries()) for (const side of ['before', 'after']) {
      const ref = 'refs/pi-task-recoveries/' + reference.split(':').at(-1) + '/record-' + index + '-' + side;
      requireValue(git(repository, ['rev-parse', ref + '^{tree}']) === retained[side].tree &&
        git(repository, ['show', '-s', '--format=%P', ref]) === retained.args.baseRef,
      'Issue recovery audit snapshots missing or changed');
    }
    return { record, records };
  }
  if (record.args.previousAttempt) {
    const prior = await authenticateAttemptChain(repository, record.args.previousAttempt, binding, seen, pendingReference);
    const previous = prior.record;
    requireValue(previous.result.status !== 'PASSED' && previous.attempt + 1 === record.attempt &&
      previous.args.baseRef === record.args.baseRef && (previous.kind === 'issue-zero-handoff' || (validContextContinuation(previous, record.args) &&
      correctionVerification(previous, record.args))) && previous.after.head === record.before.head &&
      previous.after.digest === record.before.digest &&
      previous.after.tree === record.before.tree, 'Invalid correction receipt chain');
    return { record, records: [...prior.records, record] };
  }
  requireValue(record.attempt === 1 && record.before.clean &&
    record.before.tree === git(repository, ['rev-parse', record.args.baseRef + '^{tree}']), 'Task did not start from a clean isolated baseline');
  return { record, records: [record] };
}

export async function readTaskHandoff(repository, reference, binding) {
  const chain = await authenticateAttemptChain(repository, reference, binding);
  requireValue(['issue-handoff', 'issue-zero-handoff'].includes(chain.record.kind), 'Expected an authenticated issue handoff');
  await assertLatestAttempt(repository, reference, binding, chain.record.attempt);
  return chain.record;
}

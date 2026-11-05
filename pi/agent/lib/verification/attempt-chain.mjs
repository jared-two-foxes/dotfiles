import { validContextContinuation } from '../delivery-state/delivery-context.mjs';
import { rebasedAttemptTree } from '../git/recovery-tree.mjs';
// Authenticate correction epochs and explicit rebase bridges without resetting attempts.
import { isDeepStrictEqual as equal } from 'node:util';
import { git } from '../git/tree.mjs';
import { readEvidence, taskEvidenceReferences } from '../evidence/store.mjs';
import { validateBinding } from '../delivery-state/binding.mjs';
import { sameVerification, correctionVerification } from './checks.mjs';
import { readReconciliation } from './reconciliation.mjs';
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


// A same-tree failed attempt still consumes budget. Do not select an older
// receipt or intent simply because its fingerprint also matches current files.
export async function assertLatestAttempt(repository, reference, binding, attempt) {
  for (const otherRef of await taskEvidenceReferences(repository)) {
    const other = await readEvidence(repository, otherRef);
    if (!equal(other.task, binding)) continue;
    if (other.attempt > attempt || (reference && other.startedReference === reference))
      throw Object.assign(new Error('A newer task attempt or terminal receipt exists; inspect and use the latest retained evidence without resetting its count'),
        reference ? { code: 'CONTINUATION_RECEIPT_STALE' } : {});
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
    const { suspensionAnchor } = await import('../delivery-state/issue-anchors.mjs');
    const { checkpointHistory } = await import('./checkpoint-history.mjs');
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
    await suspensionAnchor(repository, parked, record.recovery.feature, record.recovery);
    const anchor = record.recovery.reconciliationRef ? await readReconciliation(repository, record.recovery.reconciliationRef,
      record.recovery.feature, record.recovery) : null;
    await checkpointHistory(repository, record.recovery.feature, { head: record.args.baseRef,
      baseline: record.recovery.featureBaseRef, branch: record.recovery.branch, anchor });
    return { record, records: [record] };
  }
  if (record.kind === 'issue-handoff') {
    const prior = await authenticateAttemptChain(repository, record.args.previousAttempt, binding, seen, pendingReference);
    const previous = prior.record, recovery = record.recovery;
    const parked = await readEvidence(repository, recovery.suspensionRef);
    const { suspensionAnchor } = await import('../delivery-state/issue-anchors.mjs');
    await suspensionAnchor(repository, parked, recovery.feature, recovery);
    const { issueDesignRequirements } = await import('../scaffold/contracts.mjs');
    const { checkpointHistory } = await import('./checkpoint-history.mjs');
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
    const anchor = recovery.reconciliationRef ? await readReconciliation(repository, recovery.reconciliationRef,
      recovery.feature, { featureBaseRef: recovery.featureBaseRef, branch: recovery.branch }) : null;
    await checkpointHistory(repository, recovery.feature, { head: record.args.baseRef,
      baseline: recovery.featureBaseRef, branch: recovery.branch, anchor });
    const records = [...prior.records, record];
    if (reference !== pendingReference) for (const [index, retained] of records.entries()) for (const side of ['before', 'after']) {
      const ref = 'refs/pi-task-recoveries/' + reference.split(':').at(-1) + '/record-' + index + '-' + side;
      requireValue(git(repository, ['rev-parse', ref + '^{tree}']) === retained[side].tree &&
        git(repository, ['show', '-s', '--format=%P', ref]) === retained.args.baseRef,
      'Issue recovery audit snapshots missing or changed');
    }
    return { record, records };
  }
  if (record.kind === 'rebase-handoff') {
    const prior = await authenticateAttemptChain(repository, record.args.previousAttempt, binding, seen, pendingReference);
    const previous = prior.record, recovery = record.recovery;
    requireValue(previous.result.status !== 'PASSED' && previous.attempt === record.attempt &&
      previous.args.baseRef !== record.args.baseRef && sameVerification(previous.args, record.args) &&
      record.args.requirements === carriedRequirements(previous.args.requirements, prior.records) &&
      record.result.status === 'BLOCKED' && record.result.reason === 'REBASE_RECOVERY_READY' &&
      equal(record.before, record.after) && recovery?.feature?.tasks?.[binding.taskId] &&
      ['in_progress', 'blocked', 'failed'].includes(recovery.feature.tasks[binding.taskId].status), 'Invalid interrupted task handoff');
    const anchor = await readReconciliation(repository, recovery.reconciliationRef, recovery.feature,
      { featureBaseRef: recovery.featureBaseRef, branch: recovery.branch });
    requireValue(anchor.head === record.args.baseRef && anchor.record.oldHead === previous.args.baseRef &&
      anchor.record.interruptedTask === binding.taskId && equal(anchor.record.interruptedSource, record.before) &&
      !record.before.bookkeepingVisible && record.before.tree === rebasedAttemptTree(repository, previous, record.args.baseRef).tree &&
      [git(repository, ['rev-parse', record.args.baseRef + '^{tree}']), record.before.tree].includes(recovery.indexTree),
    'Handoff tree, completed prefix or index does not match retained source');
    const records = [...prior.records, record];
    if (reference !== pendingReference) {
      const prefix = 'refs/pi-task-recoveries/' + reference.split(':').at(-1);
      for (const [index, retained] of records.entries()) for (const side of ['before', 'after']) {
        const ref = prefix + '/record-' + index + '-' + side;
        requireValue(git(repository, ['rev-parse', ref + '^{tree}']) === retained[side].tree &&
          git(repository, ['show', '-s', '--format=%P', ref]) === retained.args.baseRef &&
          git(repository, ['show', '-s', '--format=%B', ref]) === 'Pi task recovery snapshot ' + index + ' ' + side,
        'Recovery audit snapshots are missing or changed; resume retained handoff to repair only missing refs');
      }
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
  requireValue(['rebase-handoff', 'issue-handoff', 'issue-zero-handoff'].includes(chain.record.kind), 'Expected an authenticated task rebase handoff');
  await assertLatestAttempt(repository, reference, binding, chain.record.attempt);
  return chain.record;
}

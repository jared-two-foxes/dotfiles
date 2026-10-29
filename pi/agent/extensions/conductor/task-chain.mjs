// Authenticate correction epochs and explicit rebase bridges without resetting attempts.
import { isDeepStrictEqual as equal } from 'node:util';
import { git } from './git-tree.mjs';
import { readEvidence, validateBinding, taskEvidenceReferences } from './evidence.mjs';
import { sameVerification } from './verification.mjs';
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
  requireValue(text.length <= 180000, 'Retained findings exceed review scope limit; explicit bounded recovery design required');
  return text;
}

// Git object writes only: no checkout, real-index change, stash, hooks or branch move.
// A conflict or any extra/missing source edit is deliberately not guessed away.
export const recoveryCommitEnvironment = { GIT_AUTHOR_NAME: 'Pi Recovery', GIT_AUTHOR_EMAIL: 'pi-recovery@localhost',
  GIT_COMMITTER_NAME: 'Pi Recovery', GIT_COMMITTER_EMAIL: 'pi-recovery@localhost',
  GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z' };

export function rebasedAttemptTree(repository, previous, head) {
  const sourceCommit = git(repository, ['commit-tree', previous.after.tree, '-p', previous.after.head],
    { input: 'Pi interrupted task source snapshot\n', env: recoveryCommitEnvironment });
  // A retained HEAD_CHANGED terminal receipt already snapshots the dirty tree
  // on the new HEAD. Preserve that exact tree; never replay or merge it twice.
  if (previous.after.head === head && previous.result.status === 'BLOCKED' && previous.result.reason === 'HEAD_CHANGED')
    return { tree: previous.after.tree, sourceCommit };
  requireValue(previous.after.head === previous.args.baseRef, 'Receipt crossed an unrelated Git revision');
  const merged = git(repository, ['merge-tree', '--write-tree', '--merge-base=' + previous.args.baseRef, head, sourceCommit]);
  const tree = merged.split('\n')[0];
  requireValue(sha(tree), 'Cannot deterministically transplant the retained task tree');
  return { tree, sourceCommit };
}

// A same-tree failed attempt still consumes budget. Do not select an older
// receipt or intent simply because its fingerprint also matches current files.
export async function assertLatestAttempt(repository, reference, binding, attempt) {
  for (const otherRef of await taskEvidenceReferences(repository)) {
    const other = await readEvidence(repository, otherRef);
    if (!equal(other.task, binding)) continue;
    requireValue(!(other.attempt > attempt) && other.startedReference !== reference,
      'A newer task attempt or terminal receipt exists; inspect and use the latest retained evidence without resetting its count');
  }
}

export async function authenticateAttemptChain(repository, reference, binding, seen = new Set(), pendingReference) {
  requireValue(!seen.has(reference) && seen.size < 64, 'Cyclic or excessive correction/recovery chain'); seen.add(reference);
  validateBinding(binding);
  const record = await readEvidence(repository, reference);
  requireValue(equal(record.task, binding) && equal(record.args?.task, binding) &&
    Number.isInteger(record.attempt) && record.attempt >= 1 && record.attempt <= 5 &&
    sha(record.args.baseRef) && record.before?.head === record.args.baseRef && sha(record.after?.head) &&
    (record.after.head === record.args.baseRef || (record.result?.status === 'BLOCKED' && record.result.reason === 'HEAD_CHANGED')) &&
    sha(record.before.tree) && sha(record.after.tree) &&
    typeof record.before.digest === 'string' && typeof record.after.digest === 'string' &&
    ['PASSED', 'NEEDS_DESIGN', 'BLOCKED'].includes(record.result?.status), 'Invalid task correction receipt');
  if (record.kind === 'issue-handoff') {
    const prior = await authenticateAttemptChain(repository, record.args.previousAttempt, binding, seen, pendingReference);
    const previous = prior.record, recovery = record.recovery;
    const parked = await readEvidence(repository, recovery.suspensionRef);
    const { issueDesignRequirements } = await import('./issue-state.mjs');
    const { checkpointHistory } = await import('./history.mjs');
    requireValue(parked.kind === 'issue-suspension' && equal(parked.task, binding) &&
      parked.args.previousAttempt === record.args.previousAttempt && equal(parked.after, previous.after) &&
      previous.result.status !== 'PASSED' && previous.attempt === record.attempt && record.attempt < 5 &&
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
    requireValue(previous.result.status !== 'PASSED' && previous.attempt === record.attempt && previous.attempt < 5 &&
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
      previous.args.baseRef === record.args.baseRef && previous.args.requirements === record.args.requirements &&
      sameVerification(previous.args, record.args) && previous.after.head === record.before.head &&
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
  requireValue(['rebase-handoff', 'issue-handoff'].includes(chain.record.kind), 'Expected an authenticated task rebase handoff');
  await assertLatestAttempt(repository, reference, binding, chain.record.attempt);
  return chain.record;
}

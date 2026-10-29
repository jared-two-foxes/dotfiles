// Explicit UI-authorized issue parking. Never discard the saved stash or old receipts.
import { suspensionAnchor } from './issue-anchors.mjs';
import path from 'node:path';
import { isDeepStrictEqual as equal } from 'node:util';
import { git, assertNoGitOperation, currentIndexTree } from './git-tree.mjs';
import { snapshot, readEvidence, retainEvidence, validateBinding } from './evidence.mjs';
import { authenticateAttemptChain, assertLatestAttempt, carriedRequirements, rebasedAttemptTree, recoveryCommitEnvironment, readTaskHandoff } from './task-chain.mjs';
import { pinHandoff } from './interrupted-rebase.mjs';
import { checkpointHistory } from './history.mjs';
import { readReconciliation } from './reconciliation.mjs';
import { issueFeature, approvedIssue, issueDesignRequirements, issueMutation } from './issue-state.mjs';
const requireValue = (ok, message) => { if (!ok) throw new Error(message); };
const definition = task => Object.fromEntries(Object.entries(task).filter(([k]) => !['status', 'history', 'designs', 'design_history', 'suspension'].includes(k)));
async function scope(args, context, options) {
  validateBinding(args.task);
  const repository = path.resolve(git(context.directory, ['rev-parse', '--show-toplevel']));
  await assertNoGitOperation(repository); context.abort?.throwIfAborted();
  requireValue(typeof args.defaultBranch === 'string' && args.defaultBranch && Array.isArray(args.protectedBranches) &&
    !['main', 'master', args.defaultBranch, ...args.protectedBranches].includes(args.branch) &&
    git(repository, ['symbolic-ref', '--short', 'HEAD']) === args.branch, 'Known unprotected feature branch required');
  let remoteDefault;
  try { remoteDefault = git(repository, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).replace(/^origin\//, ''); } catch {}
  requireValue(args.branch !== remoteDefault, 'Default branch issue recovery prohibited');
  const feature = await issueFeature(repository, args.task, options);
  requireValue(feature && feature.original_baseline === args.featureBaseRef && feature.branch === args.branch, 'Recursive issue workflow and original branch/baseline required');
  return { repository, feature };
}
async function prefix(repository, feature, args, head) {
  const anchor = args.reconciliationRef ? await readReconciliation(repository, args.reconciliationRef, feature,
    { featureBaseRef: args.featureBaseRef, branch: args.branch }) : null;
  return checkpointHistory(repository, feature, { head, baseline: args.featureBaseRef, branch: args.branch, anchor });
}
export async function suspendIssue(args, context = {}, options = {}) {
  let suspensionRef, repository;
  try {
    const s = await scope(args, context, options); ({ repository } = s);
    const feature = s.feature, task = feature.tasks[args.task.taskId];
    let record;
    if (args.suspensionRef) {
      suspensionRef = args.suspensionRef; record = await readEvidence(repository, suspensionRef);
      requireValue(record.kind === 'issue-suspension' && equal(record.task, args.task) &&
        record.suspension.branch === args.branch && record.suspension.featureBaseRef === args.featureBaseRef &&
        record.suspension.reason === args.reason, 'Suspension scope mismatch');
      if (feature.workflow.phase === 'design' && task.suspension?.reference === suspensionRef)
        return { status: 'DESIGN', suspensionRef, consumedAttempts: record.attempt, recovered: true };
    } else {
      requireValue(feature.workflow.phase === 'implement' && task && ['in_progress', 'blocked', 'failed'].includes(task.status), 'An active unfinished issue is required');
      requireValue(typeof args.reason === 'string' && args.reason.trim(), 'Discovery reason required');
      const beforeStart = await snapshot(repository);
      const chain = args.previousAttempt ? await authenticateAttemptChain(repository, args.previousAttempt, args.task) : null;
      if (!chain) {
        await assertLatestAttempt(repository, undefined, args.task, 0);
        requireValue(beforeStart.clean && !beforeStart.bookkeepingVisible, 'Zero-attempt suspension requires clean source/index');
      }
      const previous = chain?.record ?? { attempt: 0, result: { status: 'BLOCKED' }, after: beforeStart,
        args: { task: args.task, baseRef: beforeStart.head } };
      await assertLatestAttempt(repository, args.previousAttempt, args.task, previous.attempt);
      const before = await snapshot(repository);
      requireValue(previous.result.status !== 'PASSED' && previous.attempt < 5 && equal(before, previous.after) &&
        before.head === previous.args.baseRef && !before.bookkeepingVisible, 'Use latest unfinished receipt with unchanged source and remaining attempts');
      await prefix(repository, feature, args, before.head);
      const indexTree = await currentIndexTree(repository, path.resolve(repository, git(repository, ['rev-parse', '--git-path', 'index'])));
      const sourceCommit = git(repository, ['commit-tree', before.tree, '-p', before.head],
        { input: 'Pi suspended issue snapshot\n', env: recoveryCommitEnvironment });
      record = { kind: 'issue-suspension', repository, task: args.task, attempt: previous.attempt,
        args: { ...previous.args, previousAttempt: args.previousAttempt }, before, after: before,
        result: { status: 'BLOCKED', reason: 'ISSUE_SUSPENDED' },
        suspension: { branch: args.branch, featureBaseRef: args.featureBaseRef, reconciliationRef: args.reconciliationRef,
          reason: args.reason, feature, indexTree, sourceCommit } };
      // Intent is durable BEFORE any source is parked; its reference is the recovery handle.
      suspensionRef = await retainEvidence(repository, record);
      await options.interrupt?.('afterIntent');
    }
    const saved = record.suspension;
    requireValue(equal(definition(task), definition(saved.feature.tasks[args.task.taskId])), 'Suspended issue definition changed');
    const sourceRef = 'refs/pi-issue-suspensions/' + suspensionRef.split(':').at(-1);
    const stashRef = sourceRef + '-stash';
    let existing;
    try { existing = git(repository, ['rev-parse', '--verify', stashRef]); } catch {}
    const before = await snapshot(repository);
    requireValue(before.head === record.before.head && (equal(before, record.before) || before.clean), 'Suspension intent is stale; preserve source');
    await assertLatestAttempt(repository, record.args.previousAttempt, args.task, record.attempt);
    requireValue(await options.authorize?.({ operation: 'suspend', task: args.task, suspensionRef, branch: args.branch,
      source: record.before, reason: saved.reason, consumedAttempts: record.attempt,
      action: 'Retain source/index/untracked files in Git snapshots and a saved stash, then clean this issue worktree and return to design. No commit on the feature branch or attempt reset.' }), 'Issue suspension authorization required');
    context.abort?.throwIfAborted(); await assertNoGitOperation(repository);
    requireValue(equal(await snapshot(repository), before) && equal(await issueFeature(repository, args.task, options), feature), 'State changed during suspension authorization');
    let sourceExisting;
    try { sourceExisting = git(repository, ['rev-parse', '--verify', sourceRef]); } catch {}
    requireValue(!sourceExisting || sourceExisting === saved.sourceCommit, 'Suspension snapshot ref changed');
    if (!sourceExisting) git(repository, ['update-ref', sourceRef, saved.sourceCommit, '0'.repeat(40)]);
    if (record.attempt) await pinHandoff(repository, record.args.previousAttempt, record);
    const indexCommit = git(repository, ['commit-tree', saved.indexTree, '-p', record.before.head],
      { input: 'Pi suspended issue index snapshot\n', env: recoveryCommitEnvironment });
    let indexSaved;
    try { indexSaved = git(repository, ['rev-parse', '--verify', sourceRef + '-index']); } catch {}
    requireValue(!indexSaved || indexSaved === indexCommit, 'Saved issue index ref changed');
    if (!indexSaved) git(repository, ['update-ref', sourceRef + '-index', indexCommit, '0'.repeat(40)]);
    if (!record.before.clean && !existing) {
      if (!before.clean) {
        git(repository, ['stash', 'push', '--include-untracked', '--message', 'Pi issue suspension ' + suspensionRef]);
        await options.interrupt?.('afterStash');
      }
      // A killed call may have saved the stash before pinning it. Discover by exact intent marker.
      const entries = git(repository, ['stash', 'list', '--format=%H %s']).split('\n')
        .filter(line => line.endsWith('Pi issue suspension ' + suspensionRef));
      requireValue(entries.length === 1, 'Cannot identify saved stash; preserve snapshot and inspect stash list');
      existing = entries[0].split(' ')[0];
      git(repository, ['update-ref', stashRef, existing, '0'.repeat(40)]);
    }
    requireValue((await snapshot(repository)).clean && git(repository, ['rev-parse', 'HEAD']) === record.before.head, 'Parking did not leave a clean baseline');
    await issueMutation(repository, args.task, 'design-reopen', { reason: saved.reason, reference: suspensionRef }, options);
    return { status: 'DESIGN', suspensionRef, consumedAttempts: record.attempt,
      message: 'Issue changes retained; design the new issues and approve the graph before implementation' };
  } catch (error) { return { status: 'BLOCKED', message: error.message, suspensionRef, repository }; }
}

export async function resumeIssue(args, context = {}, options = {}) {
  let repository, handoffRef;
  try {
    const s = await scope(args, context, options); ({ repository } = s);
    const feature = s.feature, task = approvedIssue(feature, args.task);
    const parked = await readEvidence(repository, args.suspensionRef);
    requireValue(parked.kind === 'issue-suspension' && equal(parked.task, args.task) &&
      task.suspension?.reference === args.suspensionRef && parked.suspension.branch === args.branch &&
      parked.suspension.featureBaseRef === args.featureBaseRef, 'Suspension binding mismatch');
    await suspensionAnchor(repository, parked, feature, args);
    const chain = parked.attempt ? await authenticateAttemptChain(repository, parked.args.previousAttempt, args.task) : { records: [] };
    const previous = chain.record ?? parked;
    await assertLatestAttempt(repository, parked.args.previousAttempt, args.task, previous.attempt);
    requireValue(equal(parked.after, previous.after) && equal(definition(task), definition(parked.suspension.feature.tasks[args.task.taskId])), 'Suspended source/task mismatch');
    const head = git(repository, ['rev-parse', 'HEAD']);
    await prefix(repository, feature, args, head);
    requireValue(Object.values(feature.tasks).filter(t => t.parent_id === task.id).every(t => t.status === 'completed' && t.checkpoint), 'Complete and checkpoint all child issues before restoring parent');
    const sourceRef = 'refs/pi-issue-suspensions/' + args.suspensionRef.split(':').at(-1);
    requireValue(git(repository, ['rev-parse', sourceRef]) === parked.suspension.sourceCommit, 'Saved snapshot is missing');
    const expected = rebasedAttemptTree(repository, previous, head).tree;
    const indexCommit = git(repository, ['rev-parse', sourceRef + '-index']);
    requireValue(git(repository, ['rev-parse', indexCommit + '^{tree}']) === parked.suspension.indexTree, 'Saved index snapshot changed');
    const expectedIndex = git(repository, ['merge-tree', '--write-tree', '--merge-base=' + previous.args.baseRef, head, indexCommit]).split('\n')[0];
    const requirements = (parked.attempt ? carriedRequirements(previous.args.requirements, chain.records) :
      [...task.acceptance_criteria, ...task.constraints].join('\n')) + issueDesignRequirements(task);
    if (args.handoffRef || task.suspension.handoff) {
      handoffRef = args.handoffRef ?? task.suspension.handoff;
      await pinHandoff(repository, handoffRef, await readEvidence(repository, handoffRef));
      const h = await readTaskHandoff(repository, handoffRef, args.task);
      requireValue(['issue-handoff', 'issue-zero-handoff'].includes(h.kind) && h.recovery.suspensionRef === args.suspensionRef &&
        (h.recovery.reconciliationRef ?? null) === (args.reconciliationRef ?? null) && equal(await snapshot(repository), h.after), 'Stale issue handoff');
      await issueMutation(repository, args.task, 'issue-resume', { reference: args.suspensionRef, handoff: handoffRef }, options);
      const { input, ...resume } = h.args;
      return { status: 'READY', handoffRef, consumedAttempts: h.attempt, resume: { ...resume, previousAttempt: handoffRef } };
    }
    const before = await snapshot(repository);
    // After a killed restore, exact snapshot matching permits evidence-only completion.
    requireValue(before.clean || before.tree === expected, 'Unrelated current changes; preserve them before restoring issue');
    requireValue(await options.authorize?.({ operation: 'resume', task: args.task, suspensionRef: args.suspensionRef,
      sourceTree: expected, head, consumedAttempts: previous.attempt,
      action: 'Restore saved issue changes and staging onto verified prerequisite checkpoints. Retain the saved stash and establish a continuation baseline without resetting attempts.' }), 'Issue restore authorization required');
    context.abort?.throwIfAborted(); await assertNoGitOperation(repository);
    requireValue(equal(await snapshot(repository), before) && equal(await issueFeature(repository, args.task, options), feature), 'State changed during restore authorization');
    if (before.clean && !parked.before.clean) {
      const stash = git(repository, ['rev-parse', '--verify', sourceRef + '-stash']);
      // No pop/drop/reset: conflict leaves original stash/snapshots intact and returns BLOCKED.
      git(repository, ['stash', 'apply', '--index', stash]);
    }
    await options.interrupt?.('afterRestore');
    const after = await snapshot(repository);
    requireValue(after.head === head && after.tree === expected && !after.bookkeepingVisible &&
      await currentIndexTree(repository, path.resolve(repository, git(repository, ['rev-parse', '--git-path', 'index']))) === expectedIndex, 'Restored source differs from authenticated transplant; preserve saved snapshots');
    const h = { kind: parked.attempt ? 'issue-handoff' : 'issue-zero-handoff', repository, task: args.task, attempt: previous.attempt,
      args: { ...previous.args, baseRef: head, requirements, reconciliationRef: args.reconciliationRef, previousAttempt: parked.args.previousAttempt },
      before: after, after, result: { status: 'BLOCKED', reason: 'ISSUE_RECOVERY_READY' },
      recovery: { suspensionRef: args.suspensionRef, feature, featureBaseRef: args.featureBaseRef, branch: args.branch,
        reconciliationRef: args.reconciliationRef, indexTree: expectedIndex } };
    handoffRef = await retainEvidence(repository, h);
    await options.interrupt?.('afterHandoffRetention');
    await pinHandoff(repository, handoffRef, h);
    await readTaskHandoff(repository, handoffRef, args.task);
    await issueMutation(repository, args.task, 'issue-resume', { reference: args.suspensionRef, handoff: handoffRef }, options);
    const { input, ...resume } = h.args;
    return { status: 'READY', handoffRef, consumedAttempts: previous.attempt, remainingAttempts: 5 - previous.attempt,
      resume: { ...resume, previousAttempt: handoffRef }, message: 'Start the same issue and obtain fresh implementation approval; READY is not PASSED' };
  } catch (error) { return { status: 'BLOCKED', message: error.message, handoffRef, repository,
    recovery: 'Preserve the saved stash, private refs and old receipts. Inspect conflicts/current source; never reset attempts or replay stash blindly' }; }
}

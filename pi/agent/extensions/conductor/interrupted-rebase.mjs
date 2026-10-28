// Native, explicitly authorized recovery: preserve dirty task work and consumed attempts.
import path from 'node:path';
import { isDeepStrictEqual as equal } from 'node:util';
import { git, assertNoGitOperation, currentIndexTree } from './git-tree.mjs';
import { snapshot, retainEvidence, readEvidence, validateBinding } from './evidence.mjs';
import { authenticateAttemptChain, rebasedAttemptTree, carriedRequirements, readTaskHandoff, recoveryCommitEnvironment, assertLatestAttempt } from './task-chain.mjs';
import { reconcileFeature, readReconciliation } from './reconciliation.mjs';
import { planFor } from './feature-verification.mjs';
import { scaffoldTasks } from '../scaffold/adapter.mjs';
const requireValue = (ok, message) => { if (!ok) throw new Error(message); };
const result = (status, message) => ({ schema: 'pi.interrupted-task-recovery/v1', status, message });
const definition = task => Object.fromEntries(Object.entries(task).filter(([key]) => !['status', 'history'].includes(key)));

async function state(repository, featureId, options) {
  const response = await scaffoldTasks({ operation: 'list', feature_id: featureId }, { directory: repository }, options.scaffoldOptions);
  requireValue(response.ok, 'Cannot inspect Scaffold: ' + (response.message ?? 'invalid state'));
  return response.data.feature;
}
function resumeArgs(handoff, reference) {
  const { input, previousAttempt, ...args } = handoff.args;
  // Deliberately omit old source operations. The agent must author a fresh correction.
  return { ...args, previousAttempt: reference };
}

// Pin every historical snapshot, not just the latest tree. Compare existing audit
// refs on retry; repair only missing refs, never replace an unexpected object.
async function pinHandoff(repository, reference, handoff) {
  const { records } = await authenticateAttemptChain(repository, reference, handoff.task, new Set(), reference);
  const prefix = 'refs/pi-task-recoveries/' + reference.split(':').at(-1);
  const updates = [];
  for (const [index, record] of records.entries()) {
    for (const side of ['before', 'after']) {
      const commit = git(repository, ['commit-tree', record[side].tree, '-p', record.args.baseRef],
        { input: 'Pi task recovery snapshot ' + index + ' ' + side + '\n', env: recoveryCommitEnvironment });
      const ref = prefix + '/record-' + index + '-' + side;
      let existing;
      try { existing = git(repository, ['rev-parse', '--verify', '--quiet', ref]); } catch {}
      requireValue(!existing || existing === commit, 'Recovery audit ref unexpectedly changed');
      if (!existing) updates.push('create ' + ref + ' ' + commit);
    }
  }
  if (updates.length) git(repository, ['update-ref', '--stdin'], { input: 'start\n' + updates.join('\n') + '\nprepare\ncommit\n' });
}

export async function recoverInterruptedTaskRebase(args, context = {}, options = {}) {
  let repository, reconciliationRef, handoffRef;
  try {
    context.abort?.throwIfAborted(); validateBinding(args?.task);
    requireValue(args.featureId === args.task.featureId && args.designRef === args.task.designRef, 'Feature and task identity mismatch');
    repository = path.resolve(git(context.directory, ['rev-parse', '--show-toplevel']));
    await assertNoGitOperation(repository);
    requireValue(typeof args.defaultBranch === 'string' && args.defaultBranch.trim() &&
      Array.isArray(args.protectedBranches) && args.protectedBranches.every(b => typeof b === 'string') &&
      !['main', 'master', args.defaultBranch, ...args.protectedBranches].includes(args.branch) &&
      git(repository, ['symbolic-ref', '--quiet', '--short', 'HEAD']) === args.branch, 'Known unprotected feature branch required');
    let remoteDefault;
    try { remoteDefault = git(repository, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']).replace(/^origin\//, ''); } catch {}
    requireValue(args.branch !== remoteDefault, 'Default branch recovery prohibited');
    const before = await snapshot(repository);
    requireValue(before.head === args.headRef && !before.bookkeepingVisible, 'HEAD changed or Scaffold enters recovery scope');
    const feature = await state(repository, args.featureId, options);
    const task = feature.tasks[args.task.taskId];
    requireValue(feature.design_ref === args.designRef && task && ['in_progress', 'blocked', 'failed'].includes(task.status),
      'Recovery requires this same active, blocked or failed task; never replace it with a new task');
    if (args.resumeHandoffRef) {
      const recovered = await authenticateAttemptChain(repository, args.resumeHandoffRef, args.task, new Set(), args.resumeHandoffRef);
      const h = recovered.record;
      requireValue(h.kind === 'rebase-handoff', 'Expected a retained task handoff');
      await assertLatestAttempt(repository, args.resumeHandoffRef, args.task, h.attempt);
      requireValue(h.args.previousAttempt === args.previousAttempt && h.args.baseRef === args.headRef &&
        h.recovery.featureBaseRef === args.featureBaseRef && h.recovery.branch === args.branch &&
        equal(before, h.after) && equal(definition(task), definition(h.recovery.feature.tasks[args.task.taskId])), 'Retained handoff is stale');
      const anchor = await readReconciliation(repository, h.recovery.reconciliationRef, feature, args);
      requireValue(anchor.record.oldHead === args.oldHeadRef && anchor.baseline === args.upstreamBaseRef &&
        equal(anchor.record.plan, planFor(args)) &&
        (anchor.record.previousReconciliationRef ?? null) === (args.previousReconciliationRef ?? null), 'Handoff targets another rebase or verification plan');
      await pinHandoff(repository, args.resumeHandoffRef, h);
      await readTaskHandoff(repository, args.resumeHandoffRef, args.task);
      return { ...result('READY', 'Recovered retained handoff; task remains unverified'), handoffRef: args.resumeHandoffRef,
        reconciliationRef: h.recovery.reconciliationRef, consumedAttempts: h.attempt, remainingAttempts: 5 - h.attempt,
        resume: resumeArgs(h, args.resumeHandoffRef), recovered: true };
    }
    const chain = await authenticateAttemptChain(repository, args.previousAttempt, args.task);
    const previous = chain.record;
    await assertLatestAttempt(repository, args.previousAttempt, args.task, previous.attempt);
    requireValue(previous.result.status !== 'PASSED' && previous.attempt < 5 && previous.args.baseRef === args.oldHeadRef &&
      previous.args.baseRef !== args.headRef, 'Recovery requires unfinished retained work, changed baseline and remaining attempts');
    const transplanted = rebasedAttemptTree(repository, previous, args.headRef);
    requireValue(transplanted.tree === before.tree,
      'Current files do not exactly match the retained task tree transplanted onto rebased HEAD; preserve both trees and explicitly reconcile conflicts/extra edits');
    const indexPath = path.resolve(repository, git(repository, ['rev-parse', '--git-path', 'index']));
    const indexTree = await currentIndexTree(repository, indexPath);
    requireValue([git(repository, ['rev-parse', args.headRef + '^{tree}']), before.tree].includes(indexTree),
      'Divergent staged variant cannot be recovered automatically');
    const requirements = carriedRequirements(previous.args.requirements, chain.records);
    const unchanged = async () => {
      context.abort?.throwIfAborted(); await assertNoGitOperation(repository);
      await assertLatestAttempt(repository, args.previousAttempt, args.task, previous.attempt);
      requireValue(git(repository, ['symbolic-ref', '--quiet', '--short', 'HEAD']) === args.branch &&
        equal(await snapshot(repository), before) && equal(await state(repository, args.featureId, options), feature) &&
        await currentIndexTree(repository, indexPath) === indexTree, 'Source, index, branch or Scaffold changed during recovery');
    };
    await unchanged();
    const prefix = await reconcileFeature({ ...args, resumeEvidenceRef: args.prefixEvidenceRef }, context, {
      ...options, interruptedTask: { taskId: args.task.taskId, snapshot: before },
      authorize: scope => options.authorize?.({ ...scope, interruptedTask: args.task, consumedAttempts: previous.attempt,
        remainingAttempts: 5 - previous.attempt, sourceTree: before.tree,
        originalRequirements: previous.args.requirements, carriedRequirements: requirements,
        taskVerification: previous.args.checks ?? { buildCommand: previous.args.buildCommand, testCommand: previous.args.testCommand } }),
    });
    reconciliationRef = prefix.evidenceRef;
    requireValue(prefix.status === 'PASSED', 'Completed-prefix verification did not pass: ' + (prefix.message ?? prefix.status));
    await unchanged(); await options.interrupt?.('afterPrefix');
    const handoff = {
      kind: 'rebase-handoff', repository, task: args.task, attempt: previous.attempt,
      args: { ...previous.args, baseRef: args.headRef, requirements, previousAttempt: args.previousAttempt },
      before, after: before, request: null, response: null,
      result: { status: 'BLOCKED', stage: 'RECOVERY', reason: 'REBASE_RECOVERY_READY',
        message: 'Explicit baseline handoff only; task implementation and verification remain unfinished' },
      recovery: { reconciliationRef, featureBaseRef: args.featureBaseRef, branch: args.branch, feature, indexTree },
    };
    handoffRef = await retainEvidence(repository, handoff);
    await options.interrupt?.('beforeAuditRefs');
    await pinHandoff(repository, handoffRef, handoff);
    await options.interrupt?.('afterHandoffRetention'); await unchanged();
    await readTaskHandoff(repository, handoffRef, args.task);
    return { ...result('READY', 'Completed prefix verified; interrupted task remains unverified'), handoffRef, reconciliationRef,
      consumedAttempts: previous.attempt, remainingAttempts: 5 - previous.attempt, resume: resumeArgs(handoff, handoffRef) };
  } catch (error) {
    return { ...result('BLOCKED', error.message), handoffRef, reconciliationRef,
      recovery: 'Preserve work and old receipts. Inspect current Git, Scaffold and returned evidence; never reset source, replace task identity or restart attempt count' };
  }
}

export async function inspectTaskRebaseRecovery(args, context = {}, options = {}) {
  try {
    const repository = path.resolve(git(context.directory, ['rev-parse', '--show-toplevel']));
    const receipt = await readEvidence(repository, args.reference);
    const record = await readTaskHandoff(repository, args.reference, receipt.task);
    let applicable = false, reason;
    try {
      await assertNoGitOperation(repository);
      const feature = await state(repository, receipt.task.featureId, options);
      requireValue(equal(await snapshot(repository), record.after) &&
        git(repository, ['symbolic-ref', '--quiet', '--short', 'HEAD']) === record.recovery.branch &&
        equal(definition(feature.tasks[receipt.task.taskId]), definition(record.recovery.feature.tasks[receipt.task.taskId])) &&
        feature.tasks[receipt.task.taskId].status !== 'completed', 'Handoff source or task changed');
      await readReconciliation(repository, record.recovery.reconciliationRef, feature,
        { featureBaseRef: record.recovery.featureBaseRef, branch: record.recovery.branch });
      applicable = true;
    } catch (error) { reason = error.message; }
    return { ok: true, reference: args.reference, record, applicable, reason, consumedAttempts: record.attempt, remainingAttempts: 5 - record.attempt };
  } catch (error) { return { ok: false, message: error.message }; }
}

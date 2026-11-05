// Conductor's post-review Git commit command. It consumes an immutable successful
// receipt; never applies source changes or reruns implementation/review.
import { authenticateTaskEvidence } from './task-evidence.mjs';
import { requireFeatureAuthorization, featureAuthorized } from './feature-authorization.mjs';
import { checkpointVerifiedTask } from './checkpoint.mjs';
import { snapshot } from './evidence.mjs';
import { assertLatestAttempt } from './task-chain.mjs';
import { issueMutation, issueExecutionScope, issueDesignRequirements } from './issue-state.mjs';
import { scaffoldTasks } from '../../extensions/scaffold/adapter.mjs';
import { git, assertNoGitOperation } from './git-tree.mjs';
import path from 'node:path';
const requireValue = (ok, message) => { if (!ok) throw new Error(message); };

export async function commitVerifiedTask(args, context = {}, options = {}) {
  try {
    await requireFeatureAuthorization(args, context, options);
    const repository = path.resolve(git(context.directory, ['rev-parse', '--show-toplevel']));
    await assertNoGitOperation(repository);
    requireValue(typeof args.defaultBranch === 'string' && args.defaultBranch.trim() &&
      Array.isArray(args.protectedBranches) && args.protectedBranches.every(x => typeof x === 'string'), 'Known branch protection metadata required');
    requireValue(!['main', 'master', args.defaultBranch, ...args.protectedBranches].includes(args.branch), 'Protected branch checkpoint prohibited');
    const record = await authenticateTaskEvidence(repository, args.evidenceRef, args.task);
    await assertLatestAttempt(repository, args.evidenceRef, args.task, record.attempt);
    const response = await scaffoldTasks({ operation: 'list', feature_id: args.task.featureId }, context, options.scaffoldOptions);
    const feature = response.data?.feature, task = feature?.tasks?.[args.task.taskId];
    requireValue(response.ok && feature.design_ref === args.task.designRef && feature.branch === args.branch &&
      feature.original_baseline === args.featureBaseRef, 'Checkpoint feature scope changed');
    requireValue(['in_progress', 'completed'].includes(task?.status), 'Task must be active or already completed with matching evidence');
    requireValue(task.designs?.length === 1 && record.args.requirements.includes(issueDesignRequirements(task)),
      'Issue design changed after review; previous evidence cannot finalize this design');
    if (task.status === 'in_progress') {
      const current = await snapshot(repository);
      requireValue(current.head === record.args.baseRef && current.digest === record.after.digest &&
        current.tree === record.after.tree && !current.bookkeepingVisible, 'Source changed after review; task not completed');
      await issueExecutionScope(repository, feature, record.args);
      await issueMutation(repository, args.task, 'complete', { feature_id: args.task.featureId,
        task_id: args.task.taskId, result: 'PASSED', source: 'conductor', reference: args.evidenceRef,
        summary: 'Requested checks and independent review passed; automatic verified checkpoint follows' }, options);
    }
    const checkpoint = await checkpointVerifiedTask({ ...args, authorizationMode: 'feature' }, context,
      { ...options, authorize: () => featureAuthorized(args, context, options) });
    requireValue(checkpoint.ok, checkpoint.message ?? 'Verified Git checkpoint failed');
    return { schema: 'pi.task-finalization/v1', ok: true, checkpoint };
  } catch (error) {
    return { schema: 'pi.task-finalization/v1', ok: false, message: error.message,
      recovery: 'Retry finalization with the same successful evidence; never reapply operations.' };
  }
}


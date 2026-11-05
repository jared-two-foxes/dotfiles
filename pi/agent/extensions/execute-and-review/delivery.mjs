// Native Pi delivery: Executor, checks, Review and verified Git commit in ONE
// Conductor command list. Recovery may invoke a commit-only list.
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { executeAndReview, hydrateContinuation } from './adapter.mjs';
import { git } from '../../lib/delivery-state/git-tree.mjs';
import { requireFeatureAuthorization } from '../../lib/delivery-state/feature-authorization.mjs';
import { scaffoldTasks } from '../../lib/scaffold/adapter.mjs';
import { validateCheckpoint } from '../../lib/delivery-state/checkpoint-recovery.mjs';
import { runPipeline } from './pipeline.mjs';
import { inspectIssueHandoff } from '../../lib/delivery-state/issue-context.mjs';
const requireValue = (ok, message) => { if (!ok) throw new Error(message); };
function continuationBlocked(reason, message, task, consumedAttempts) {
  const recovery = task?.featureId && task?.taskId
    ? { tool: 'prepare_issue_handoff', featureId: task.featureId, taskId: task.taskId }
    : undefined;
  return { schema: 'opencode.execute_and_review.result/v1', status: 'BLOCKED', stage: 'PRECHECK',
    reason, message, task, consumedAttempts, recovery };
}

export async function executeAndCheckpoint(args, context = {}, options = {}) {
  if (args?.issueHandoffRef !== undefined) {
    const { issueHandoffRef, ...executionArgs } = args;
    if (args.previousAttempt !== undefined)
      return continuationBlocked('CONTINUATION_INPUT_CONFLICT',
        'Supply issueHandoffRef or previousAttempt, using one continuation input', args.task);
    if (!/^pi-issue-context:sha256:[a-f0-9]{64}$/.test(issueHandoffRef))
      return continuationBlocked('CONTINUATION_HANDOFF_INVALID', 'Invalid issue handoff reference', args.task);

    const result = await inspectIssueHandoff({ reference: issueHandoffRef },
      { ...context, directory: context.worktree ?? context.directory ?? '.' }, options);
    if (!result.ok)
      return continuationBlocked('CONTINUATION_HANDOFF_INVALID', result.message, args.task);
    if (!result.applicable)
      return continuationBlocked('CONTINUATION_HANDOFF_STALE', result.reason, args.task ?? { featureId: result.refresh.featureId, taskId: result.refresh.taskId });

    const { binding, attempt } = result.handoff;
    if (args.task && !isDeepStrictEqual(args.task, binding))
      return continuationBlocked('CONTINUATION_TASK_MISMATCH', 'Issue handoff belongs to a different task or design', args.task);
    if (!attempt?.matches_source || attempt.status === 'PASSED')
      return continuationBlocked('CONTINUATION_RECEIPT_INAPPLICABLE',
        attempt?.status === 'PASSED' ? 'Attempt already PASSED; recover checkpoint finalization'
          : 'Handoff requires a retained attempt matching current source, index and HEAD',
        binding, attempt?.consumed_attempts);
    args = { ...executionArgs, task: binding, previousAttempt: attempt.reference };
  }
  try {
    args = await hydrateContinuation(args, context);
  } catch (error) {
    return continuationBlocked(error.code?.startsWith('CONTINUATION_') ? error.code : 'CONTINUATION_CONTEXT_INVALID',
      error.message, args?.task, error.consumedAttempts);
  }
  try {
    validateCheckpoint(args?.checkpoint);
    requireValue(Object.keys(args.checkpoint).every(k => ['defaultBranch', 'protectedBranches'].includes(k)), 'Unexpected checkpoint metadata');
    await requireFeatureAuthorization(args, context, options);
    const response = await scaffoldTasks({ operation: 'list', feature_id: args.task?.featureId }, context, options.scaffoldOptions);
    requireValue(response.ok, 'Cannot inspect feature for automatic commit');
    const feature = response.data.feature;
    requireValue(!['main', 'master', args.checkpoint.defaultBranch, ...args.checkpoint.protectedBranches].includes(feature.branch),
      'Automatic commit on a protected branch prohibited');
    const result = await executeAndReview(args, context, { ...options, issueWorkflowOnly: true,
      pipeline: meta => runPipeline(meta, feature, context, options),
    });
    return result.reason?.startsWith('CONTINUATION_')
      ? { ...result, ...continuationBlocked(result.reason, result.message, args.task, result.consumedAttempts) }
      : result;
  } catch (error) {
    return { schema: 'opencode.execute_and_review.result/v1', status: 'BLOCKED', stage: 'PRECHECK', reason: 'AUTOMATIC_CHECKPOINT_CONTEXT', message: error.message };
  }
}

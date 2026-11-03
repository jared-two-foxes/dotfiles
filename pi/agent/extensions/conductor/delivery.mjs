// Native Pi delivery: Executor, checks, Review and verified Git commit in ONE
// Conductor command list. Recovery may invoke a commit-only list.
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import { lstat, mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { executeAndReview, hydrateContinuation, invoke, DEFAULT_TIMEOUT_MS } from './adapter.mjs';
import { git } from './git-tree.mjs';
import { requireFeatureAuthorization } from './feature-authorization.mjs';
import { scaffoldTasks } from '../scaffold/adapter.mjs';
import { validateRunner, toolOutput } from './protocol.mjs';
import { authenticateTaskEvidence } from './task-evidence.mjs';
import { snapshot } from './evidence.mjs';
import { runPipeline } from './pipeline.mjs';
import { inspectIssueHandoff } from './issue-context.mjs';
const requireValue = (ok, message) => { if (!ok) throw new Error(message); };
const sha = value => /^[a-f0-9]{40}$/.test(value ?? '');

export function validateCheckpoint(value) {
  requireValue(value && typeof value.defaultBranch === 'string' && value.defaultBranch.trim() &&
    value.defaultBranch === value.defaultBranch.trim() && !value.defaultBranch.includes('\0') &&
    Array.isArray(value.protectedBranches) && value.protectedBranches.every(x => typeof x === 'string' && x.trim() && x === x.trim() && !x.includes('\0')),
  'checkpoint requires the known defaultBranch and protectedBranches (or [])');
}

export async function finalizeVerifiedTask(args, context = {}, options = {}) {
  let directory, request;
  try {
    validateCheckpoint(args);
    context.abort?.throwIfAborted();
    await requireFeatureAuthorization(args, context, options);
    const repository = path.resolve(git(context.directory, ['rev-parse', '--show-toplevel']));
    const record = await authenticateTaskEvidence(repository, args.evidenceRef, args.task);
    const current = await snapshot(repository);
    // On recovery HEAD may already be the checkpoint. The checkpoint helper
    // authenticates that exact commit, its parent/tree/trailer and pending index.
    requireValue(current.head !== record.args.baseRef || current.digest === record.after.digest,
      'Current source/index differs from the reviewed receipt');
    const root = path.resolve(repository, git(repository, ['rev-parse', '--git-path', 'pi-conductor-finalization']));
    await mkdir(root, { recursive: true, mode: 0o700 });
    const info = await lstat(root);
    requireValue(info.isDirectory() && !info.isSymbolicLink(), 'Unsafe finalization directory');
    directory = await realpath(await mkdtemp(path.join(root, 'attempt-')));
    const input = path.join(directory, 'checkpoint.json');
    await writeFile(input, JSON.stringify(args), { mode: 0o600, flag: 'wx' });
    request = { schema: 'conductor.request/v2', working_directory: repository, output_directory: directory,
      commands: [{ name: 'git commit verified task', program: process.execPath,
        args: [fileURLToPath(new URL('./commit-task.mjs', import.meta.url)), input] }] };
    await writeFile(path.join(directory, 'request.json'), JSON.stringify(request), { mode: 0o600, flag: 'wx' });
    const response = await (options.invokeFinalization ?? (body => invoke(process.env.CONDUCTOR_BIN ?? 'conductor',
      ['run', '--request', '-'], { cwd: repository, signal: context.abort, input: body,
        timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS })))(JSON.stringify(request));
    await writeFile(path.join(directory, 'response.json'), JSON.stringify(response), { mode: 0o600, flag: 'wx' });
    const runner = JSON.parse(response.stdout);
    validateRunner(request, runner, response.code);
    const text = await toolOutput(request, runner, runner.commands[0]);
    const result = text === undefined ? null : JSON.parse(text);
    requireValue(runner.status === 'PASSED' && result?.schema === 'pi.task-finalization/v1' && result.ok === true &&
      result.checkpoint?.ok === true && result.checkpoint.evidenceRef === args.evidenceRef &&
      result.checkpoint.featureId === args.task.featureId && result.checkpoint.taskId === args.task.taskId &&
      result.checkpoint.designRef === args.task.designRef && result.checkpoint.tree === record.after.tree &&
      result.checkpoint.nextBaseRef === result.checkpoint.commit && result.checkpoint.branch === args.branch &&
      result.checkpoint.featureBaseRef === args.featureBaseRef &&
      sha(result.checkpoint.commit) && git(repository, ['rev-parse', 'HEAD']) === result.checkpoint.commit &&
      git(repository, ['rev-parse', 'HEAD^{tree}']) === record.after.tree && (await snapshot(repository)).clean,
    result?.message ?? runner.error ?? 'Commit command did not produce an authenticated checkpoint');
    return { ok: true, ...result.checkpoint, finalizationDirectory: directory };
  } catch (error) {
    return { ok: false, reason: 'FINALIZATION_BLOCKED', message: error.message,
      evidenceRef: args?.evidenceRef, ...(directory ? { finalizationDirectory: directory } : {}),
      recovery: 'Keep the successful implementation receipt. Retry checkpoint_verified_task; never reapply operations to recover a failed commit.' };
  }
}

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

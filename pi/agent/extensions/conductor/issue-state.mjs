// The native boundary enforces the persisted phase; the agent owns design decisions.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { scaffoldTasks, checkStatePaths } from '../scaffold/adapter.mjs';
const requireValue = (ok, message) => { if (!ok) throw new Error(message); };
export async function issueFeature(repository, binding, options = {}) {
  await checkStatePaths(repository);
  let stored;
  try { stored = JSON.parse(await readFile(path.join(repository, '.scaffold', 'tasks.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  // Legacy callers retain their existing API. Only Scaffold interprets workflow state.
  if (!stored.features?.[binding.featureId]?.workflow) return null;
  const response = await scaffoldTasks({ operation: 'list', feature_id: binding.featureId },
    { directory: repository }, options.scaffoldOptions);
  requireValue(response.ok, 'Cannot inspect issue workflow: ' + response.message);
  const feature = response.data.feature;
  requireValue(feature.workflow.kind === 'recursive-issues/v1' && feature.design_ref === binding.designRef,
    'Issue workflow/design mismatch');
  return feature;
}
export function approvedIssue(feature, binding) {
  const task = feature.tasks[binding.taskId];
  requireValue(feature.workflow.phase === 'implement' && task?.designs?.length === 1, 'Entire issue graph must finish design before execution');
  return task;
}
export function issueDesignRequirements(task) {
  const d = task.designs.at(-1);
  return '\n\nApproved issue design ' + d.reference + '\n' + d.summary + '\nVerification: ' + d.verification +
    '\nApproval record: ' + d.approval;
}
export async function issueMutation(repository, binding, operation, payload, options = {}) {
  const response = await scaffoldTasks({ operation, feature_id: binding.featureId, task_id: binding.taskId, payload },
    { directory: repository }, options.scaffoldOptions);
  requireValue(response.ok, response.message ?? 'Issue transition failed');
  return response.data.feature;
}

export async function requireIssueBinding(directory) {
  await checkStatePaths(directory);
  let state;
  try { state = JSON.parse(await readFile(path.join(directory, '.scaffold/tasks.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  requireValue(!Object.values(state.features ?? {}).some(f => f.workflow?.kind === 'recursive-issues/v1' && f.validation?.status !== 'verified'),
    'An unfinished issue workflow requires explicit feature/issue binding; complete its design graph first');
}

export async function issueExecutionScope(repository, feature, args) {
  const { git } = await import('./git-tree.mjs');
  const { readReconciliation } = await import('./reconciliation.mjs');
  const { checkpointHistory } = await import('./history.mjs');
  const branch = feature.branch, baseline = feature.original_baseline;
  requireValue(git(repository, ['symbolic-ref', '--short', 'HEAD']) === branch && args.baseRef === git(repository, ['rev-parse', 'HEAD']), 'Issue branch/baseline changed');
  requireValue(!['main', 'master'].includes(branch), 'Issue execution requires a feature branch');
  const task = feature.tasks[args.task.taskId];
  requireValue([...task.acceptance_criteria, ...task.constraints].every(c => args.requirements.includes(c)), 'Preserve original issue criteria/constraints in review requirements');
  const anchor = args.reconciliationRef ? await readReconciliation(repository, args.reconciliationRef, feature,
    { featureBaseRef: baseline, branch }) : null;
  await checkpointHistory(repository, feature, { head: args.baseRef, baseline, branch, anchor });
}

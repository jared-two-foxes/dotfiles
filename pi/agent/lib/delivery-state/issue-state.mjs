// The native boundary enforces the persisted phase; the agent owns design decisions.
import { readScaffoldState } from '../scaffold/adapter.mjs';
import { authorizedScaffoldTasks } from './issue-authorization.mjs';
const requireValue = (ok, message) => { if (!ok) throw new Error(message); };
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
// Persisted policy is authoritative; callers supply only additional scope. Keep
// this idempotent for existing callers that already supply the canonical text.
export function issueRequirements(task, additional) {
  requireValue(typeof additional === 'string', 'Issue requirements must be a string');
  const missing = [...task.acceptance_criteria, ...task.constraints, issueDesignRequirements(task)]
    .filter(text => !additional.includes(text));
  return additional + (missing.length ? '\n\n' + missing.join('\n') : '');
}
export async function issueMutation(repository, binding, operation, payload, options = {}) {
  const response = await authorizedScaffoldTasks({ operation, feature_id: binding.featureId, task_id: binding.taskId, payload },
    { directory: repository }, options.scaffoldOptions);
  requireValue(response.ok, response.message ?? 'Issue transition failed');
  return response.data.feature;
}

export async function requireIssueBinding(directory) {
  const state = await readScaffoldState(directory);
  requireValue(!Object.values(state?.features ?? {}).some(f => f.workflow?.kind === 'recursive-issues/v1' && f.validation?.status !== 'verified'),
    'An unfinished issue workflow requires explicit feature/issue binding; complete its design graph first');
}

export async function issueExecutionScope(repository, feature, args) {
  const { git } = await import('./git-tree.mjs');
  const { readReconciliation } = await import('./reconciliation-evidence.mjs');
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

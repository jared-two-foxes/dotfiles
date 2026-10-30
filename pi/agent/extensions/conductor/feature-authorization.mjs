// Durable authority for one approved feature direction. Separate from verification evidence.
import path from 'node:path';
import { isDeepStrictEqual as equal } from 'node:util';
import { git } from './git-tree.mjs';
import { approvedDesign } from './feature-verification.mjs';
import { scaffoldTasks } from '../scaffold/adapter.mjs';
import { retainFeatureEvidence, readFeatureEvidence, featureEvidenceReferences } from './evidence.mjs';
const requireValue = (ok, message) => { if (!ok) throw new Error(message); };
const capabilities = ['design', 'implementation', 'checks', 'independent-review', 'local-checkpoints', 'issue-recovery', 'rebase-verification'];
async function scopeFor(args, context, options) {
  context.abort?.throwIfAborted();
  const repository = path.resolve(git(context.directory, ['rev-parse', '--show-toplevel']));
  let defaultBranch;
  try { defaultBranch = git(repository, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).replace(/^origin\//, ''); } catch {}
  const featureId = args.featureId ?? args.task?.featureId;
  const response = await scaffoldTasks({ operation: 'list', feature_id: featureId }, { directory: repository }, options.scaffoldOptions);
  requireValue(response.ok, 'Cannot inspect feature direction');
  const f = response.data.feature;
  requireValue(f.workflow?.kind === 'recursive-issues/v1' && f.branch && f.branch !== defaultBranch && f.original_baseline &&
    (!args.designRef || args.designRef === f.design_ref) &&
    (!args.task || (args.task.featureId === featureId && args.task.designRef === f.design_ref && f.tasks[args.task.taskId])) &&
    (!args.branch || args.branch === f.branch) && (!args.featureBaseRef || args.featureBaseRef === f.original_baseline) &&
    git(repository, ['symbolic-ref', '--short', 'HEAD']) === f.branch && !['main', 'master'].includes(f.branch), 'Feature authority scope mismatch');
  return { repository, featureId, designRef: f.design_ref, branch: f.branch, baseline: f.original_baseline,
    direction: approvedDesign(repository, f), objective: f.objective, acceptanceCriteria: f.acceptance_criteria,
    constraints: f.constraints ?? [], capabilities };
}
async function existing(scope) {
  for (const reference of await featureEvidenceReferences(scope.repository)) {
    const record = await readFeatureEvidence(scope.repository, reference);
    if (record.kind === 'feature-authorization' && equal(record.scope, scope)) return reference;
  }
}
export async function featureAuthorized(args, context = {}, options = {}) {
  try { return !!await existing(await scopeFor(args, context, options)); } catch { return false; }
}
export async function requireFeatureAuthorization(args, context = {}, options = {}) {
  requireValue(await featureAuthorized(args, context, options),
    'Approve the overall feature direction once with approve_feature_direction before implementation. No per-issue approval is required within that scope');
}
export async function approveFeatureDirection(args, context = {}, options = {}) {
  try {
    const scope = await scopeFor(args, context, options);
    const prior = await existing(scope);
    if (prior) return { ok: true, reference: prior, scope, recovered: true };
    requireValue(await options.confirm?.(scope), 'Feature direction approval required');
    context.abort?.throwIfAborted();
    requireValue(equal(scope, await scopeFor(args, context, options)), 'Feature direction changed during approval');
    const reference = await retainFeatureEvidence(scope.repository, { kind: 'feature-authorization', scope });
    return { ok: true, reference, scope };
  } catch (error) { return { ok: false, message: error.message }; }
}

import { readFile } from 'node:fs/promises';
// Durable authority for one approved feature direction. Separate from verification evidence.
import path from 'node:path';
import { isDeepStrictEqual as equal } from 'node:util';
import { git } from './git-tree.mjs';
import { approvedDesign } from './feature-verification.mjs';
import { scaffoldTasks } from '../../extensions/scaffold/adapter.mjs';
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
  const currentBranch = git(repository, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  requireValue(currentBranch === f.branch,
    'Feature branch mismatch: current ' + currentBranch + ', expected ' + f.branch +
    '. Create or switch to the feature branch before approving or executing; approval does not switch branches.');
  for (const [field, value] of [['designRef', args.designRef], ['task.designRef', args.task?.designRef]]) {
    if (value === undefined) continue;
    requireValue(/^sha256:[a-f0-9]{64}$/.test(value), field +
      ' must be sha256: followed by 64 lowercase hex characters (71 characters total); received ' + String(value).length +
      '. Read the exact design_ref from scaffold_tasks issue/select. Expected: ' + f.design_ref);
    requireValue(value === f.design_ref, field + ' mismatch: expected ' + f.design_ref + ', received ' + value +
      '. Inspect the current feature; do not reapprove an unchanged direction.');
  }
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
async function requireRecoverableAuthority(scope) {
  const state = JSON.parse(await readFile(path.join(scope.repository, '.scaffold/tasks.json'), 'utf8'));
  requireValue(!Object.values(state.features[scope.featureId].tasks).some(t => t.delivery),
    'EVIDENCE_RECOVERY_REQUIRED: original feature authorization is missing; restore evidence, never reapprove unchanged direction to reset execution history');
}
export async function requireFeatureAuthorization(args, context = {}, options = {}) {
  const scope = await scopeFor(args, context, options);
  if (!await existing(scope)) await requireRecoverableAuthority(scope);
  requireValue(await existing(scope),
    'Approve the overall feature direction once with approve_feature_direction before implementation. No per-issue approval is required within that scope');
}
export async function approveFeatureDirection(args, context = {}, options = {}) {
  try {
    const scope = await scopeFor(args, context, options);
    const prior = await existing(scope);
    if (prior) return { ok: true, reference: prior, scope, recovered: true };
    await requireRecoverableAuthority(scope);
    requireValue(await options.confirm?.(scope), 'Feature direction approval required');
    context.abort?.throwIfAborted();
    requireValue(equal(scope, await scopeFor(args, context, options)), 'Feature direction changed during approval');
    const reference = await retainFeatureEvidence(scope.repository, { kind: 'feature-authorization', scope });
    return { ok: true, reference, scope };
  } catch (error) { return { ok: false, message: error.message }; }
}

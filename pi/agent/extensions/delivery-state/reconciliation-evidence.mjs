// Authenticate retained rebase receipts without running recovery operations.
import { isDeepStrictEqual as equal } from 'node:util';
import { git } from './git-tree.mjs';
import { readFeatureEvidence } from './evidence.mjs';
import { checkpointHistory, checkpointProvenance } from './history.mjs';
import { authenticateTaskEvidence } from './task-evidence.mjs';
import { approvedDesign, featureRequirements, authenticateFeatureRecord } from './feature-verification.mjs';

const requireValue = (ok, message) => { if (!ok) throw new Error(message); };
export const completedTasks = feature => Object.fromEntries(Object.entries(feature.tasks).filter(([, t]) => t.status === 'completed'));
const identity = feature => [feature.id, feature.design_ref, feature.context, feature.acceptance_criteria, feature.constraints ?? []];

export function mappedCheckpoints(repository, source, baseline, head) {
  git(repository, ['merge-base', '--is-ancestor', baseline, head]);
  const commits = git(repository, ['rev-list', '--reverse', baseline + '..' + head]).split('\n').filter(Boolean);
  requireValue(commits.length === source.length, 'Rebase dropped, squashed, duplicated or added task commits; explicit task reconciliation required');
  let parent = baseline;
  return commits.map((commit, index) => {
    const previous = source[index];
    requireValue(git(repository, ['show', '-s', '--format=%P', commit]) === parent &&
      equal(checkpointProvenance(repository, commit), checkpointProvenance(repository, previous.commit)),
    'Rebased checkpoint ordering, identity or parent mismatch');
    const mapped = { ...previous, commit, rebasedParent: parent, rebasedTree: git(repository, ['rev-parse', commit + '^{tree}']) };
    parent = commit;
    return mapped;
  });
}

export async function reconciliationRequirements(repository, feature, source, originalBaseline, baseline) {
  let requirements = featureRequirements(feature, approvedDesign(repository, feature)) +
    '\n\nREBASE RECOVERY: Only the completed task prefix below is implemented; pending feature criteria remain deferred. ' +
    'Review the entire rebased completed prefix against the new upstream, including conflict resolutions, regressions and interfaces. ' +
    'Old receipts are historical and do not verify rewritten trees.\nOriginal baseline: ' + originalBaseline + '\nNew upstream baseline: ' + baseline;
  for (const checkpoint of source) {
    const evidence = await authenticateTaskEvidence(repository, checkpoint.evidenceRef,
      { featureId: feature.id, taskId: checkpoint.taskId, designRef: feature.design_ref });
    requirements += '\n\nCompleted task ' + checkpoint.taskId + ':\n' + evidence.args.requirements;
  }
  return requirements;
}

export async function readReconciliation(repository, reference, feature, args, seen = new Set()) {
  requireValue(!seen.has(reference), 'Cyclic reconciliation chain'); seen.add(reference);
  const r = await readFeatureEvidence(repository, reference);
  requireValue(r.kind === 'reconciliation' && r.result?.schema === 'pi.feature-reconciliation/v1' && r.result.status === 'PASSED',
    'Missing successful rebase reconciliation');
  requireValue(r.binding.feature_id === feature.id && r.binding.design_ref === feature.design_ref &&
    r.originalBaseline === args.featureBaseRef && r.binding.branch === args.branch && equal(identity(r.feature), identity(feature)),
  'Reconciliation feature, design, branch or original baseline mismatch');
  for (const [id, task] of Object.entries(completedTasks(r.feature)))
    requireValue(equal(feature.tasks[id], task), 'Reconciled task changed or lost completion evidence');
  const prior = r.previousReconciliationRef
    ? await readReconciliation(repository, r.previousReconciliationRef, r.feature, args, seen) : undefined;
  const source = await checkpointHistory(repository, r.feature,
    { head: r.oldHead, baseline: r.originalBaseline, branch: args.branch, anchor: prior });
  requireValue(equal(source, r.sourceCheckpoints), 'Historical checkpoint evidence changed');
  requireValue(r.oldHead !== r.binding.head, 'No history change to reconcile');
  git(repository, ['merge-base', '--is-ancestor', prior?.baseline ?? r.originalBaseline, r.binding.baseline]);
  const checkpoints = mappedCheckpoints(repository, source, r.binding.baseline, r.binding.head);
  requireValue(equal(checkpoints, r.checkpoints), 'Rebased checkpoint mapping changed');
  const requirements = await reconciliationRequirements(repository, r.feature, source, r.originalBaseline, r.binding.baseline);
  authenticateFeatureRecord(r, r.binding, r.plan, r.feature.tasks, requirements, 'pi.feature-reconciliation/v1');
  requireValue(r.binding.tree === git(repository, ['rev-parse', r.binding.head + '^{tree}']), 'Reconciled tree changed');
  return { reference, head: r.binding.head, baseline: r.binding.baseline, checkpoints, tasks: completedTasks(r.feature), record: r };
}

// Authenticate each task receipt behind a recorded checkpoint and confirm it agrees with the ledger.
// The ledger's checkpoint segment (task, parent, tree, reference) and the retained receipt were
// written separately; a mismatch means either was tampered with or recorded for the wrong task.
import { isDeepStrictEqual as equal } from 'node:util';
import { authenticateTaskEvidence } from './task-evidence.mjs';

const requireValue = (ok, message) => { if (!ok) throw new Error(message); };

/** The ledger's checkpoints, oldest first, each with its authenticated receipt. */
export async function authenticatedCheckpoints(repository, feature) {
  const checkpoints = [];
  for (const segment of feature.history ?? []) {
    if (segment.kind !== 'checkpoint') continue;
    const task = feature.tasks[segment.task_id];
    requireValue(task?.status === 'completed' && task.checkpoint?.commit === segment.commit,
      'Recorded checkpoint ' + segment.commit + ' does not match its task\'s completion');
    const completion = task.history.at(-1);
    requireValue(completion?.to === 'completed' && completion.evidence?.reference === task.checkpoint.reference &&
      completion.evidence?.source === 'conductor' && completion.evidence?.result === 'PASSED' &&
      completion.evidence?.feature_id === feature.id && completion.evidence?.task_id === segment.task_id,
    'Checkpoint does not match Scaffold completion');
    const evidence = await authenticateTaskEvidence(repository, task.checkpoint.reference,
      { featureId: feature.id, taskId: segment.task_id, designRef: feature.design_ref });
    requireValue(evidence.args.baseRef === segment.parent && evidence.after.tree === segment.tree,
      'Receipt and checkpoint disagree');
    checkpoints.push({ commit: segment.commit, taskId: segment.task_id, evidenceRef: task.checkpoint.reference, parent: segment.parent, tree: segment.tree });
  }
  const completed = Object.values(feature.tasks).filter(t => t.status === 'completed').map(t => t.id).sort();
  requireValue(equal(completed, checkpoints.map(c => c.taskId).sort()),
    'Every completed task requires a recorded checkpoint, including empty parents');
  return checkpoints;
}

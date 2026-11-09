// Authenticate each task receipt behind a recorded checkpoint and confirm it agrees with the ledger.
// The ledger's checkpoint segment (task, parent, tree, reference) and the retained receipt were
// written separately; a mismatch means either was tampered with or recorded for the wrong task.
import { isDeepStrictEqual as equal } from 'node:util';
import { authenticateTaskEvidence } from './task-evidence.mjs';
import { readFeatureEvidence } from '../evidence/store.mjs';

const requireValue = (ok, message) => { if (!ok) throw new Error(message); };

// A history-rewrite gives each checkpoint a new commit, parent and tree but keeps its task and its
// receipt, which still describes the history it was produced in. That history is retained as an epoch,
// so a receipt is compared with the earliest recorded form of its checkpoint; a checkpoint recorded
// in the current epoch is compared directly. Each epoch's rewrite verification must also be a retained,
// passing verification of that exact previous head.
async function authenticateEpochs(repository, feature) {
  const epochs = feature.epochs ?? [];
  for (const [index, epoch] of epochs.entries()) {
    const verification = await readFeatureEvidence(repository, epoch.verification, { featureId: feature.id });
    requireValue(verification.kind === 'history-rewrite-verification' && verification.result?.status === 'PASSED' &&
      verification.oldHead === epoch.head && verification.previousBase === epoch.base,
    'The retained verification of a history rewrite does not match the recorded epoch');
    // The rewrite produced exactly the history that follows: the next epoch's history, or the current one,
    // which may only have gained checkpoints after the rewrite.
    const following = epochs[index + 1]?.history ?? feature.history;
    requireValue(equal(following.slice(0, verification.newHistory.length), verification.newHistory),
      'The retained verification of a history rewrite does not cover the recorded history');
  }
}
const originalForm = (feature, segment) => {
  for (const epoch of feature.epochs ?? []) {
    const found = epoch.history.find(s => s.kind === 'checkpoint' && s.task_id === segment.task_id);
    if (found) return found;
  }
  return segment;
};

/** The ledger's checkpoints, oldest first, each with its authenticated receipt. */
export async function authenticatedCheckpoints(repository, feature) {
  await authenticateEpochs(repository, feature);
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
    const original = originalForm(feature, segment);
    requireValue(evidence.args.baseRef === original.parent && evidence.after.tree === original.tree,
      'Receipt and checkpoint disagree');
    checkpoints.push({ commit: segment.commit, taskId: segment.task_id, evidenceRef: task.checkpoint.reference, parent: segment.parent, tree: segment.tree });
  }
  const completed = Object.values(feature.tasks).filter(t => t.status === 'completed').map(t => t.id).sort();
  requireValue(equal(completed, checkpoints.map(c => c.taskId).sort()),
    'Every completed task requires a recorded checkpoint, including empty parents');
  return checkpoints;
}

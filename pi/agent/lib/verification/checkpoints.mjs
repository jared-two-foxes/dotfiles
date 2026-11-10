// The ledger's checkpoints as validation uses them: oldest first, each with its receipt reference.
//
// Scaffold already refuses a checkpoint that does not continue the recorded head, and a completion that
// does not cite a recorded PASSED attempt, so receipts are not re-read here. What remains are the two
// mistakes that can still happen: a task marked completed with no checkpoint, and a checkpoint whose
// task is not the one Scaffold completed.
import { isDeepStrictEqual as equal } from 'node:util';

const requireValue = (ok, message) => { if (!ok) throw new Error(message); };

export function ledgerCheckpoints(feature) {
  const checkpoints = [];
  for (const segment of feature.history ?? []) {
    if (segment.kind !== 'checkpoint') continue;
    const task = feature.tasks[segment.task_id];
    requireValue(task?.status === 'completed' && task.checkpoint?.commit === segment.commit &&
      task.history.at(-1)?.evidence?.reference === task.checkpoint.reference,
    'Recorded checkpoint ' + segment.commit + ' does not match its task\'s completion');
    checkpoints.push({ commit: segment.commit, taskId: segment.task_id, evidenceRef: task.checkpoint.reference, parent: segment.parent, tree: segment.tree });
  }
  const completed = Object.values(feature.tasks).filter(t => t.status === 'completed').map(t => t.id).sort();
  requireValue(equal(completed, checkpoints.map(c => c.taskId).sort()),
    'Every completed task requires a recorded checkpoint, including empty parents');
  return checkpoints;
}

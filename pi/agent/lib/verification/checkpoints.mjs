// The ledger's checkpoints as validation uses them: oldest first, each with its receipt reference.
//
// Scaffold already refuses a checkpoint that does not continue the recorded head, and a completion that
// does not cite a recorded PASSED attempt, so receipts are not re-read here. What remains are the two
// mistakes that can still happen: a task marked completed with no checkpoint, and a checkpoint whose
// task or content is not the one Scaffold completed. Content is compared with the base and tree recorded
// on the task's PASSED attempt, which is a ledger field, so no receipt is read.
import { isDeepStrictEqual as equal } from 'node:util';

const requireValue = (ok, message) => { if (!ok) throw new Error(message); };

// A history-rewrite gives each checkpoint a new commit, parent and tree but keeps its task and attempt,
// which still describe the history they were produced in. That history is retained as an epoch, so the
// attempt is compared with the earliest recorded form of its checkpoint.
const originalForm = (feature, segment) => {
  for (const epoch of feature.epochs ?? []) {
    const found = epoch.history?.find(s => s.kind === 'checkpoint' && s.task_id === segment.task_id);
    if (found) return found;
  }
  return segment;
};

export function ledgerCheckpoints(feature) {
  const checkpoints = [];
  for (const segment of feature.history ?? []) {
    if (segment.kind !== 'checkpoint') continue;
    const task = feature.tasks[segment.task_id];
    requireValue(task?.status === 'completed' && task.checkpoint?.commit === segment.commit &&
      task.history.at(-1)?.evidence?.reference === task.checkpoint.reference,
    'Recorded checkpoint ' + segment.commit + ' does not match its task\'s completion');
    const attempt = task.attempts?.find(a => a.receipt === task.checkpoint.reference);
    const original = originalForm(feature, segment);
    requireValue(attempt?.status === 'PASSED' && attempt.base === original.parent && attempt.tree === original.tree,
      'Recorded checkpoint ' + segment.commit + ' does not match the base and tree of its task\'s passed attempt');
    checkpoints.push({ commit: segment.commit, taskId: segment.task_id, evidenceRef: task.checkpoint.reference, parent: segment.parent, tree: segment.tree });
  }
  const completed = Object.values(feature.tasks).filter(t => t.status === 'completed').map(t => t.id).sort();
  requireValue(equal(completed, checkpoints.map(c => c.taskId).sort()),
    'Every completed task requires a recorded checkpoint, including empty parents');
  return checkpoints;
}

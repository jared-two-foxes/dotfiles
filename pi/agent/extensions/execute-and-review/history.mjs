// Authenticate the completed prefix, optionally rooted in a verified rebase anchor.
import { isDeepStrictEqual as equal } from 'node:util';
import { git } from './git-tree.mjs';
import { authenticateTaskEvidence } from './task-evidence.mjs';
const requireValue = (ok, message) => { if (!ok) throw new Error(message); };
const sha = x => /^[a-f0-9]{40}$/.test(x ?? '');

export function checkpointProvenance(repository, commit) {
  const lines = git(repository, ['show', '-s', '--format=%B', commit]).split('\n')
    .filter(l => l.startsWith('Pi-Task-Checkpoint: '));
  requireValue(lines.length === 1, 'Missing/ambiguous checkpoint provenance');
  return JSON.parse(lines[0].slice('Pi-Task-Checkpoint: '.length));
}

export async function checkpointHistory(repository, feature, { head, baseline, branch, anchor }) {
  const tasks = feature.tasks;
  const identifiers = Object.keys(tasks).filter(id => tasks[id].status === 'completed');
  const checkpoints = [], seen = new Set();
  if (anchor) {
    for (const [id, task] of Object.entries(anchor.tasks))
      requireValue(equal(tasks[id], task), 'Reconciled task changed or lost completion evidence');
  }
  let cursor = head;
  const stop = anchor?.head ?? baseline;
  while (cursor !== stop) {
    requireValue(checkpoints.length < identifiers.length, 'Unrelated or duplicate commits in checkpoint history');
    const parents = git(repository, ['show', '-s', '--format=%P', cursor]).split(' ');
    requireValue(parents.length === 1 && sha(parents[0]), 'Checkpoint must have exactly one parent');
    const p = checkpointProvenance(repository, cursor);
    requireValue(p.schema === 'pi.task-checkpoint/v1' && p.featureId === feature.id && p.designRef === feature.design_ref &&
      p.branch === branch && p.featureBaseRef === baseline && p.baseRef === parents[0] &&
      p.tree === git(repository, ['rev-parse', cursor + '^{tree}']) && tasks[p.taskId]?.status === 'completed' && !seen.has(p.taskId) &&
      (p.reconciliationRef ?? null) === (anchor?.reference ?? null),
    'Checkpoint lineage, identity or Git tree mismatch');
    const completion = tasks[p.taskId].history.at(-1);
    requireValue(completion?.to === 'completed' && completion.evidence?.reference === p.evidenceRef &&
      completion.evidence?.source === 'conductor' && completion.evidence?.result === 'PASSED' &&
      completion.evidence?.feature_id === feature.id && completion.evidence?.task_id === p.taskId,
    'Checkpoint does not match Scaffold completion');
    const evidence = await authenticateTaskEvidence(repository, p.evidenceRef,
      { featureId: p.featureId, taskId: p.taskId, designRef: p.designRef });
    requireValue(evidence.args.baseRef === p.baseRef && evidence.after.tree === p.tree, 'Receipt and checkpoint disagree');
    checkpoints.unshift({ commit: cursor, ...p }); seen.add(p.taskId); cursor = parents[0];
  }
  if (anchor) checkpoints.unshift(...anchor.checkpoints);
  const completed = new Set();
  for (const p of checkpoints) {
    const task = tasks[p.taskId];
    requireValue(task?.status === 'completed' && !completed.has(p.taskId), 'Duplicate or incomplete checkpoint task');
    const dependencies = new Set(task.dependencies);
    let parent = task.parent_id;
    const ancestors = new Set();
    while (parent !== null) {
      requireValue(tasks[parent] && !ancestors.has(parent), 'Invalid recursive task ancestry');
      ancestors.add(parent); tasks[parent].dependencies.forEach(d => dependencies.add(d)); parent = tasks[parent].parent_id;
    }
    Object.values(tasks).filter(t => t.parent_id === task.id).forEach(t => dependencies.add(t.id));
    requireValue([...dependencies].every(d => completed.has(d)), 'Checkpoint ordering violates task prerequisites');
    completed.add(p.taskId);
  }
  requireValue(completed.size === identifiers.length, 'Every completed task requires an authentic checkpoint, including empty parents');
  return checkpoints;
}

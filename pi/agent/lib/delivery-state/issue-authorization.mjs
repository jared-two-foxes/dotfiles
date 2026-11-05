import { isDeepStrictEqual } from 'node:util';

const requireValue = (ok, message) => { if (!ok) throw new Error(message); };

export async function authenticateIssueMutation(repository, feature, params) {
  const { snapshot, readEvidence } = await import('./evidence.mjs');
  const current = await snapshot(repository);
  const binding = { featureId: feature.id, taskId: params.task_id, designRef: feature.design_ref };
  if (params.operation === 'design-reopen') {
    requireValue(current.clean && !current.bookkeepingVisible, 'Park unfinished source with suspend_issue before reopening design');
    if (params.payload.reference) {
      const r = await readEvidence(repository, params.payload.reference);
      const { git } = await import('./git-tree.mjs');
      requireValue(r.kind === 'issue-suspension' && isDeepStrictEqual(r.task, binding) &&
        r.before.head === current.head && git(repository, ['rev-parse', 'refs/pi-issue-suspensions/' + params.payload.reference.split(':').at(-1) + '^{tree}']) === r.before.tree,
      'Authenticated saved issue suspension required');
    }
  } else if (params.operation === 'issue-resume') {
    const { readTaskHandoff } = await import('./task-chain.mjs');
    const h = await readTaskHandoff(repository, params.payload.handoff, binding);
    requireValue(['issue-handoff', 'issue-zero-handoff'].includes(h.kind) && h.recovery.suspensionRef === params.payload.reference && isDeepStrictEqual(current, h.after), 'Authenticated issue restore required');
  } else {
    const { authenticateTaskEvidence } = await import('./task-evidence.mjs');
    const { checkpointProvenance } = await import('./history.mjs');
    const { git } = await import('./git-tree.mjs');
    const record = await authenticateTaskEvidence(repository, params.payload.reference, binding);
    const p = checkpointProvenance(repository, params.payload.commit);
    requireValue(p.evidenceRef === params.payload.reference && p.taskId === params.task_id && p.featureId === feature.id &&
      p.designRef === feature.design_ref && p.tree === record.after.tree &&
      git(repository, ['rev-parse', params.payload.commit + '^{tree}']) === record.after.tree &&
      git(repository, ['show', '-s', '--format=%P', params.payload.commit]) === record.args.baseRef && current.head === params.payload.commit && current.clean,
    'Authentic current verified checkpoint required');
  }
}

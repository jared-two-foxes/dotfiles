// Real design/lifecycle API setup shared by integration scenarios.
import { issueDesignRequirements } from '../../pi/agent/extensions/conductor/issue-state.mjs';
export async function approveGraph(call) {
  if ((await call('list')).feature.workflow.phase !== 'design') return;
  for (;;) {
    const task = (await call('design-next')).task;
    if (!task) break;
    const feature = (await call('list')).feature;
    await call('design-record', { task_id: task.id, payload: {
      summary: 'Approved contract ' + task.id, verification: 'Focused regression and integration checks',
      approval: 'Fixture user confirmed the contract',
      disposition: Object.values(feature.tasks).some(t => t.parent_id === task.id) ? 'decomposed' : 'leaf',
    } });
  }
  await call('design-finish');
}
export function requirementsFor(task, requirements) {
  const suffix = issueDesignRequirements(task);
  const missing = [...task.acceptance_criteria, ...task.constraints].filter(s => !requirements.includes(s));
  return requirements + (missing.length ? '\n' + missing.join('\n') : '') +
    (requirements.includes(suffix) ? '' : suffix);
}

// Full responses are validated above and retained by native callers. The model only
// needs an acknowledgement after a mutation; full list is an explicit diagnostic query.
export function compactMutation(result) {
  if (!result.ok || ['list', 'summary', 'issue', 'select', 'design-select'].includes(result.operation)) return result;
  const f = result.data.feature, t = result.data.task;
  return { ok: true, operation: result.operation, feature_id: result.feature_id,
    ...(result.task_id ? { task_id: result.task_id } : {}),
    data: { schema_version: 2, phase: f?.workflow.phase,
      task_revision: f?.task_revision, status: t?.status ?? f?.tasks?.[result.task_id]?.status,
      next_query: { operation: 'summary', feature_id: result.feature_id } } };
}

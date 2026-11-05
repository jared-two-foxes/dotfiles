// The native boundary enforces the persisted phase; the agent owns design decisions.
const requireValue = (ok, message) => {
  if (!ok) throw new Error(message);
};
export function approvedIssue(feature, binding) {
  const task = feature.tasks[binding.taskId];
  requireValue(
    feature.workflow.phase === "implement" && task?.designs?.length === 1,
    "Entire issue graph must finish design before execution",
  );
  return task;
}
export function issueDesignRequirements(task) {
  const d = task.designs.at(-1);
  return (
    "\n\nApproved issue design " +
    d.reference +
    "\n" +
    d.summary +
    "\nVerification: " +
    d.verification +
    "\nApproval record: " +
    d.approval
  );
}
// Persisted policy is authoritative; callers supply only additional scope. Keep
// this idempotent for existing callers that already supply the canonical text.
export function issueRequirements(task, additional) {
  requireValue(
    typeof additional === "string",
    "Issue requirements must be a string",
  );
  const missing = [
    ...task.acceptance_criteria,
    ...task.constraints,
    issueDesignRequirements(task),
  ].filter((text) => !additional.includes(text));
  return additional + (missing.length ? "\n\n" + missing.join("\n") : "");
}
export async function issueExecutionScope(repository, feature, args) {
  const { git } = await import("./git-tree.mjs");
  const { readReconciliation } = await import("./reconciliation-evidence.mjs");
  const { checkpointHistory } = await import("./history.mjs");
  const branch = feature.branch,
    baseline = feature.original_baseline;
  requireValue(
    git(repository, ["symbolic-ref", "--short", "HEAD"]) === branch &&
      args.baseRef === git(repository, ["rev-parse", "HEAD"]),
    "Issue branch/baseline changed",
  );
  requireValue(
    !["main", "master"].includes(branch),
    "Issue execution requires a feature branch",
  );
  const task = feature.tasks[args.task.taskId];
  requireValue(
    [...task.acceptance_criteria, ...task.constraints].every((c) =>
      args.requirements.includes(c),
    ),
    "Preserve original issue criteria/constraints in review requirements",
  );
  const anchor = args.reconciliationRef
    ? await readReconciliation(repository, args.reconciliationRef, feature, {
        featureBaseRef: baseline,
        branch,
      })
    : null;
  await checkpointHistory(repository, feature, {
    head: args.baseRef,
    baseline,
    branch,
    anchor,
  });
}

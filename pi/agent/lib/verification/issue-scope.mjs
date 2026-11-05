const requireValue = (ok, message) => { if (!ok) throw new Error(message); };
export async function issueExecutionScope(repository, feature, args) {
  const { git } = await import("../git/tree.mjs");
  const { readReconciliation } = await import("./reconciliation.mjs");
  const { checkpointHistory } = await import("./checkpoint-history.mjs");
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

const requireValue = (ok, message) => { if (!ok) throw new Error(message); };
import { git } from "../git/tree.mjs";
import { verifyHistory } from "./history.mjs";

// Execution may start only on the feature branch, at the ledger's recorded head, with Git matching
// the history the ledger recorded (task checkpoints and approved foreign ranges).
export async function issueExecutionScope(repository, feature, args) {
  const branch = feature.branch;
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
  verifyHistory(repository, feature, { head: args.baseRef });
}

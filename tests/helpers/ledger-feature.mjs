// Gives a fixture repository a real Scaffold feature (schema 3): designed issue graph, approved
// direction and, optionally, one started task. Receipts, attempts and checkpoints all belong to a
// feature's ledger, so tests that run the delivery pipeline need one.
import { git } from "../../pi/agent/lib/git/tree.mjs";
import { scaffoldTasks } from "../../pi/agent/extensions/scaffold/adapter.mjs";
import { approveFeatureDirection } from "../../pi/agent/extensions/scaffold/feature-authorization.mjs";
import { requirementsFor } from "./issue-plan.mjs";

export async function ledgerFeature(dir, {
  featureId = "F", taskId = "T", branch = "feature/ledger", tasks, start = true, approve = true,
  objective = "Deliver the feature", criteria = ["Feature works"],
} = {}) {
  const g = (...args) => git(dir, args);
  if (g("symbolic-ref", "--quiet", "--short", "HEAD") !== branch) g("switch", "-qc", branch);
  const baseline = g("rev-parse", "HEAD");
  const context = { directory: dir };
  const call = async (operation, payload, task_id, reason) => {
    const response = await scaffoldTasks({ operation, feature_id: featureId, ...(task_id ? { task_id } : {}),
      ...(reason ? { reason } : {}), ...(payload !== undefined ? { payload } : {}) }, context);
    if (!response.ok) throw new Error("Scaffold " + operation + " failed: " + JSON.stringify(response));
    return response.data;
  };
  const children = tasks ?? [{ id: taskId }];
  await call("init", { id: featureId, title: "Feature", objective, design_ref: "sha256:context",
    context: "Approved design", acceptance_criteria: criteria, baseline, branch });
  await call("decompose", children.map(c => ({ title: c.id, objective: "Do " + c.id,
    acceptance_criteria: [c.id + " works"], constraints: [], ...c })), featureId);
  const design = (id, disposition) => call("design-record",
    { summary: "Approved contract " + id, verification: "Checks", approval: "Fixture user confirmed", disposition }, id);
  await design(featureId, "decomposed");
  for (const child of children) await design(child.id, "leaf");
  await call("design-finish");
  if (approve) {
    const approved = await approveFeatureDirection({ featureId }, context, { confirm: async () => true });
    if (!approved.ok) throw new Error("Approval failed: " + approved.message);
  }
  const feature = async () => (await call("list")).feature;
  if (start) await call("start", undefined, taskId);
  const designRef = (await feature()).design_ref;
  return {
    designRef, baseline, branch, call, feature,
    binding: (id = taskId) => ({ featureId, taskId: id, designRef }),
    requirements: async (id = taskId, text = id + " criteria") => requirementsFor((await feature()).tasks[id], text),
  };
}

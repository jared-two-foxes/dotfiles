import { inspectReconciliation } from "./reconciliation.mjs";
import { inspectTaskRebaseRecovery } from "./interrupted-rebase.mjs";

const referencePattern = /^pi-(feature-)?evidence:sha256:[a-f0-9]{64}$/;

export async function inspectRebaseEvidence(args = {}, context = {}, options = {}) {
  const { reference, featureId } = args;
  if (reference !== undefined &&
      (typeof reference !== "string" || !referencePattern.test(reference))) {
    return { ok: false, message: "Expected a task or feature evidence reference" };
  }

  if (reference?.startsWith("pi-evidence:")) {
    const inspected = await inspectTaskRebaseRecovery({ reference }, context, options);
    if (!inspected.ok) return inspected;
    if (inspected.record.kind !== "rebase-handoff")
      return { ok: false, message: "Reference is not an interrupted-task rebase handoff" };
    if (featureId !== undefined && inspected.record.task.featureId !== featureId)
      return { ok: false, message: "Rebase handoff belongs to a different feature" };
    const { ok, ...entry } = inspected;
    return { ok: true, results: [{ ...entry, kind: "rebase-handoff" }] };
  }

  const inspected = await inspectReconciliation({ reference, featureId }, context, options);
  if (!inspected.ok) return inspected;
  if (reference !== undefined && inspected.results.length === 0)
    return { ok: false, message: "Reference is not a matching feature rebase reconciliation" };
  return {
    ok: true,
    results: inspected.results.map(entry => ({ ...entry, kind: "reconciliation" })),
  };
}

export function createRebaseInspectionTool(Type, inspect = inspectRebaseEvidence) {
  return {
    name: "inspect_rebase_evidence",
    label: "Inspect retained rebase evidence",
    description:
      "Authenticate feature rebase reconciliation or interrupted-task rebase evidence against current Git and Scaffold state. " +
      "A reference selects its receipt type automatically. Without a reference, discover feature reconciliation receipts, optionally filtered by featureId. " +
      "Returns results with kind and applicability; task handoffs include consumedAttempts and never establish task verification. Read only.",
    parameters: Type.Object({
      featureId: Type.Optional(Type.String({ minLength: 1 })),
      reference: Type.Optional(Type.String({ pattern: referencePattern.source })),
    }, { additionalProperties: false }),
    async execute(_id, params, signal, _update, ctx) {
      const result = await inspect(params, { directory: ctx.cwd, abort: signal });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        isError: !result.ok,
        details: result,
      };
    },
  };
}

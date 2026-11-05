import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { featureAuthorized } from "../delivery-state/feature-authorization.mjs";
import { validateFeature, inspectFeatureValidation } from "./feature.mjs";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "validate_feature",
    label: "Validate complete feature",
    description: "Verification-only final gate: authenticate all task checkpoints, run approved full-project checks, independently review the original baseline through final HEAD, retain evidence and record Scaffold validation. Uses the retained overall feature authorization. No implementation, commits, publishing, retries or task selection.",
    parameters: Type.Object({
      featureId: Type.String(), designRef: Type.String(), branch: Type.String(),
      featureBaseRef: Type.String(), headRef: Type.String(),
      reconciliationRef: Type.Optional(Type.String({ description: "Latest successful rebase reconciliation evidence, if history was rewritten" })),
      buildCommand: Type.Array(Type.String(), { minItems: 1 }),
      testCommand: Type.Array(Type.String(), { minItems: 1 }),
      testSuccessPattern: Type.String({ description: "Approved literal output marker demonstrating meaningful tests ran, e.g. '42 passed'. Never choose a generic exit message." }),
      integrationChecks: Type.Optional(Type.Array(Type.Object({
        name: Type.String(), command: Type.Array(Type.String(), { minItems: 1 }), successPattern: Type.String(),
      }))),
      checkTimeoutMs: Type.Optional(Type.Integer()),
      review: Type.Optional(Type.Object({
        model: Type.Optional(Type.String()), wallClockBudgetSecs: Type.Optional(Type.Integer()),
        maxTurns: Type.Optional(Type.Integer()), maxCostUsd: Type.Optional(Type.Number()),
        maxToolCalls: Type.Optional(Type.Integer()), maxRepeatedActions: Type.Optional(Type.Integer()),
        maxCompletionAttempts: Type.Optional(Type.Integer()),
      })),
      resumeEvidenceRef: Type.Optional(Type.String({ description: "Authentic retained successful feature receipt to reconcile with Scaffold; unchanged revision and plan required" })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const result = await validateFeature(params, { directory: ctx.cwd, abort: signal }, {
        authorize: async () => featureAuthorized(params, { directory: ctx.cwd, abort: signal }),
      });
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        isError: result.status === "BLOCKED", details: result };
    },
  });
  pi.registerTool({
    name: "inspect_feature_validation",
    label: "Inspect retained feature validation",
    description: "Read retained feature attempts and authenticate their applicability against current Git, task graph and checkpoint evidence. Historical PASSED may be stale. No checks, reviews or lifecycle writes.",
    parameters: Type.Object({ featureId: Type.Optional(Type.String()), reference: Type.Optional(Type.String()) }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const result = await inspectFeatureValidation(params, { directory: ctx.cwd });
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }], isError: !result.ok, details: result };
    },
  });
}

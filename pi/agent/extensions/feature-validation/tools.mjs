import { featureAuthorized } from "../scaffold/feature-authorization.mjs";
import { validateFeature, inspectFeatureValidation } from "./feature.mjs";
import { defineTool, toolResult, withFailureReporting } from "../../lib/host/tool.mjs";

// Validation binds to the ledger's movable `base` (moved by a rebase). The authorization check compares the
// immutable original baseline instead, so it is not given the validation base.
const withoutValidationBase = ({ featureBaseRef: _validationBase, ...rest }) => rest;

/** Host-neutral tools. `Type` is a TypeBox-style schema builder supplied by the host adapter. */
export function createFeatureValidationTools(Type) {
  return [
    withFailureReporting(defineTool({
      name: "validate_feature",
      label: "Validate complete feature",
      description:
        "Verification-only final gate: authenticate all task checkpoints, run approved full-project checks, independently review the original baseline through final HEAD, retain evidence and record Scaffold validation. Uses the retained overall feature authorization. No implementation, commits, publishing, retries or task selection.",
      parameters: Type.Object({
        featureId: Type.String(),
        designRef: Type.String(),
        branch: Type.String(),
        featureBaseRef: Type.String(),
        headRef: Type.String(),
        buildCommand: Type.Array(Type.String(), { minItems: 1 }),
        testCommand: Type.Array(Type.String(), { minItems: 1 }),
        testSuccessPattern: Type.String({
          description:
            "Approved literal output marker demonstrating meaningful tests ran, e.g. '42 passed'. Never choose a generic exit message.",
        }),
        integrationChecks: Type.Optional(
          Type.Array(
            Type.Object({
              name: Type.String(),
              command: Type.Array(Type.String(), { minItems: 1 }),
              successPattern: Type.String(),
            }),
          ),
        ),
        checkTimeoutMs: Type.Optional(Type.Integer()),
        review: Type.Optional(
          Type.Object({
            model: Type.Optional(Type.String()),
            wallClockBudgetSecs: Type.Optional(Type.Integer()),
            maxTurns: Type.Optional(Type.Integer()),
            maxCostUsd: Type.Optional(Type.Number()),
            maxToolCalls: Type.Optional(Type.Integer()),
            maxRepeatedActions: Type.Optional(Type.Integer()),
            maxCompletionAttempts: Type.Optional(Type.Integer()),
          }),
        ),
        resumeEvidenceRef: Type.Optional(
          Type.String({
            description:
              "Authentic retained successful feature receipt to reconcile with Scaffold; unchanged revision and plan required",
          }),
        ),
      }),
      async execute(params, host) {
        const result = await validateFeature(
          params,
          { directory: host.cwd, abort: host.signal },
          {
            authorize: async () =>
              featureAuthorized(withoutValidationBase(params), { directory: host.cwd, abort: host.signal }),
          },
        );
        return toolResult(result, { isError: result.status === "BLOCKED" });
      },
    })),
    withFailureReporting(defineTool({
      name: "inspect_feature_validation",
      label: "Inspect retained feature validation",
      description:
        "Read retained feature attempts and authenticate their applicability against current Git, task graph and checkpoint evidence. Historical PASSED may be stale. No checks, reviews or lifecycle writes.",
      parameters: Type.Object({
        featureId: Type.Optional(Type.String()),
        reference: Type.Optional(Type.String()),
      }),
      async execute(params, host) {
        return toolResult(await inspectFeatureValidation(params, { directory: host.cwd }));
      },
    })),
  ];
}

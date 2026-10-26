/**
 * Pi's native execute_and_review tool.
 *
 * Pi and OpenCode have different extension APIs; both send the same
 * conductor.request/v1 protocol to the deterministic Rust Conductor CLI.
 * The feature gate reuses bounded Review without Executor or AI retry logic.
 */
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { executeAndReview } from "./adapter.mjs";
import { checkpointVerifiedTask, checkpointAuthorization } from "./checkpoint.mjs";
import { validateFeature, inspectFeatureValidation } from "./feature.mjs";
import { inspectEvidence } from "./evidence.mjs";

export default function (pi: ExtensionAPI) {
  let checkpointContext: ExtensionContext | undefined;
  const confirmation = async (title: string, message: string) =>
    checkpointContext?.hasUI === true && await checkpointContext.ui.confirm(title, message);
  const authorizeCheckpoint = checkpointAuthorization(confirmation);
  pi.on("session_start", async () => { authorizeCheckpoint.reset(); });
  pi.registerTool({
    name: "validate_feature",
    label: "Validate complete feature",
    description: "Verification-only final gate: authenticate all task checkpoints, run approved full-project checks, independently review the original baseline through final HEAD, retain evidence and record Scaffold validation. Requires narrow Pi UI authorization. No implementation, commits, publishing, retries or task selection.",
    parameters: Type.Object({
      featureId: Type.String(), designRef: Type.String(), branch: Type.String(),
      featureBaseRef: Type.String(), headRef: Type.String(),
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
        authorize: async scope => ctx.hasUI === true && await ctx.ui.confirm("Authorize feature verification only",
          JSON.stringify(scope, null, 2) + "\nRun these full project checks and bounded independent review? This permits verification commands, temporary review requests, Git evidence and Scaffold validation bookkeeping only. No source editing, commits, push or PR actions."),
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
  pi.registerTool({
    name: "checkpoint_verified_task",
    label: "Checkpoint verified task",
    description: "After Scaffold completion and user checkpoint authorization, create or recover ONE local commit of the exact verified Git tree. No push, task selection or source implementation. Requires Pi confirmation UI; grants expire on session start/switch.",
    parameters: Type.Object({
      task: Type.Object({ featureId: Type.String(), taskId: Type.String(), designRef: Type.String() }),
      evidenceRef: Type.String(),
      featureBaseRef: Type.String({ description: "Original feature-start SHA, preserved across all task checkpoints" }),
      branch: Type.String({ description: "Explicit authorized feature branch" }),
      defaultBranch: Type.String({ description: "Known actual repository default branch" }),
      protectedBranches: Type.Array(Type.String(), { description: "All additional known protected branches; [] if none" }),
      authorizationMode: Type.Union([Type.Literal("manual"), Type.Literal("feature")]),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      checkpointContext = ctx;
      const result = await checkpointVerifiedTask(params, { directory: ctx.cwd, abort: signal }, { authorize: authorizeCheckpoint });
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        isError: !result.ok, details: result };
    },
  });
  pi.registerTool({
    name: "execute_and_review",
    label: "Execute and Review (Conductor)",
    description:
      "After explicit user approval, run ONE deterministic Conductor attempt: " +
      "apply exact executor operations, build, test and independently review. " +
      "Returns PASSED, NEEDS_DESIGN or BLOCKED. Never retries or generates fixes.",
    parameters: Type.Object({
      task: Type.Optional(Type.Object({
        featureId: Type.String(), taskId: Type.String(), designRef: Type.String(),
      }, { description: "Scaffold task identity and approved immutable design reference" })),
      previousAttempt: Type.Optional(Type.String({
        description: "Retained receipt for the previous attempt of this same task; required for corrections/recovery",
      })),
      input: Type.String({
        description: "Exact executor JSON with an operations array; authored by the agent",
      }),
      requirements: Type.String({
        description: "Current task criteria, applicable approved constraints and earlier interfaces to preserve",
      }),
      baseRef: Type.String({
        description: "Original task-start full 40-character Git SHA, unchanged across attempts",
      }),
      buildCommand: Type.Array(Type.String(), { minItems: 1, description: "Build executable and arguments, not a shell command" }),
      testCommand: Type.Array(Type.String(), { minItems: 1, description: "Test executable and arguments, not a shell command" }),
      reviewModel: Type.Optional(Type.String({
        description: "Independent review model; default opencode/gpt-6.1-sol",
      })),
      reviewWallClockBudgetSecs: Type.Optional(Type.Integer({
        description:
          "Optional review wall-clock budget in seconds " +
          "(forwards to review-cli --wall-clock-budget-secs). Omit to use the review engine default.",
      })),
      reviewMaxTurns: Type.Optional(Type.Integer({
        description:
          "Optional maximum model turns for review " +
          "(forwards to review-cli --max-turns). Omit to use the review engine default.",
      })),
      reviewMaxCostUsd: Type.Optional(Type.Number({
        description:
          "Optional review cost budget in USD " +
          "(forwards to review-cli --max-cost-usd). Omit for no cost cap.",
      })),
      reviewMaxToolCalls: Type.Optional(Type.Integer({
        description:
          "Optional maximum tool calls for review " +
          "(forwards to review-cli --max-tool-calls). Omit to use the review engine default.",
      })),
      reviewMaxRepeatedActions: Type.Optional(Type.Integer({
        description:
          "Optional maximum identical repeated tool calls before stalling " +
          "(forwards to review-cli --max-repeated-actions). Omit to use the review engine default.",
      })),
      reviewMaxCompletionAttempts: Type.Optional(Type.Integer({
        description:
          "Optional maximum completion attempts before stopping " +
          "(forwards to review-cli --max-completion-attempts). Omit to use the review engine default.",
      })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const result = await executeAndReview(params, {
        directory: ctx.cwd,
        abort: signal,
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        isError: result.status === "BLOCKED",
        details: result,
      };
    },
  });
  pi.registerTool({
    name: "inspect_conductor_evidence",
    label: "Inspect retained Conductor evidence",
    description: "Read a content-addressed task receipt and compare its tree fingerprint. No writes or lifecycle transitions. Inspect check/review output before completing a task.",
    parameters: Type.Object({ reference: Type.String() }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await inspectEvidence(params.reference, { directory: ctx.cwd });
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        isError: !result.ok, details: result };
    },
  });

}

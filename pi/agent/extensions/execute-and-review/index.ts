/**
 * Pi's native execute_and_review tool.
 *
 * Sends the
 * conductor.request/v2 command-list protocol to the deterministic Rust Conductor CLI.
 */
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { executeAndCheckpoint } from "./delivery.mjs";
import { executionSummary } from "../../lib/delivery-state/protocol.mjs";
import { approveFeatureDirection } from "../../lib/scaffold/feature-authorization.mjs";
import { inspectEvidence } from "../../lib/delivery-state/evidence.mjs";
import { approveDeliveryAmendment } from "../../lib/delivery-state/context-amendment.mjs";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "approve_delivery_amendment",
    label: "Approve material contract amendment",
    description:
      "Explicit user approval of a concrete material scope/criterion/finding delta. Retains original obligations, source, authorization and all execution history. Routine corrections do not use this tool. Apply the returned reference through contextUpdates.apply_amendment; approval never establishes verification.",
    parameters: Type.Object(
      {
        previousAttempt: Type.String(),
        ids: Type.Array(Type.String(), { minItems: 1 }),
        replacement: Type.String({ minLength: 1 }),
        reason: Type.String({ minLength: 1 }),
      },
      { additionalProperties: false },
    ),
    async execute(_id, params, signal, _update, ctx) {
      const result = await approveDeliveryAmendment(
        params,
        { directory: ctx.cwd, abort: signal },
        {
          confirm: async (scope) =>
            ctx.hasUI === true &&
            (await ctx.ui.confirm(
              "Approve this material contract change?",
              JSON.stringify(scope, null, 2) +
                "\nOriginal obligations and all execution history remain retained. Only this concrete delta is authorized; independent verification is still required.",
            )),
        },
      );
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
        details: result,
        isError: !result.ok,
      };
    },
  });
  pi.registerTool({
    name: "approve_feature_direction",
    label: "Approve feature direction",
    description:
      "The single approval for this feature's direction and local delivery loop. Persists authority for scoped design, implementation, checks, independent review, checkpoints and recovery across sessions. No per-issue confirmations. Does not authorize publishing, merging or changing the approved objectives/constraints.",
    parameters: Type.Object(
      { featureId: Type.String() },
      { additionalProperties: false },
    ),
    async execute(_id, params, signal, _update, ctx) {
      const result = await approveFeatureDirection(
        params,
        { directory: ctx.cwd, abort: signal },
        {
          confirm: async (scope) =>
            ctx.hasUI === true &&
            (await ctx.ui.confirm(
              "Approve overall design direction and implementation?",
              JSON.stringify(scope, null, 2) +
                "\nProceed with this feature through design, implementation, checks, independent review, local checkpoints and recovery without further routine confirmations? Stop for changes outside this approved direction. Publishing and merging are separate.",
            )),
        },
      );
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
        details: result,
        isError: !result.ok,
      };
    },
  });
  pi.registerTool({
    name: "execute_and_review",
    label: "Execute and Review (Conductor)",
    description:
      "Under the approved feature direction, construct and run ONE Conductor v2 command list: " +
      "external Executor, caller-selected verification, then external Review. After approval, automatically record task completion and run a verified Git commit command through Conductor. " +
      "Returns PASSED, NEEDS_DESIGN or BLOCKED. One call never retries or generates fixes; Pi diagnoses recoverable failures and continues with an applicable issueHandoffRef or the latest previousAttempt against its retained after-tree. Use empty operations for verification-only retries.",
    parameters: Type.Object({
      checkpoint: Type.Optional(
        Type.Object(
          {
            defaultBranch: Type.String({
              description:
                "Known repository default branch; protected from automatic commits",
            }),
            protectedBranches: Type.Array(Type.String(), {
              description: "All additional known protected branches, or []",
            }),
          },
          {
            additionalProperties: false,
            description:
              "Automatic post-review local commit context; branch and original baseline come from the approved feature; inherited on continuation",
          },
        ),
      ),
      reconciliationRef: Type.Optional(
        Type.String({
          description: "Verified rebase anchor for recursive issue execution",
        }),
      ),
      task: Type.Optional(
        Type.Object(
          {
            featureId: Type.String(),
            taskId: Type.String(),
            designRef: Type.String(),
          },
          {
            description:
              "Scaffold task identity and approved immutable design reference",
          },
        ),
      ),
      previousAttempt: Type.Optional(
        Type.String({
          description:
            "Retained receipt for the previous attempt of this same task. Supply this or issueHandoffRef for corrections/recovery.",
        }),
      ),
      issueHandoffRef: Type.Optional(
        Type.String({
          description:
            "Applicable saved issue handoff. Resolve its exact latest receipt for continuation. Use instead of previousAttempt.",
        }),
      ),
      reviewProbe: Type.Optional(
        Type.Boolean({
          description:
            "Explicit bounded no-source health probe after environment-only credential repair. A failed probe is throttled for five minutes; no assertion of repair grants approval.",
        }),
      ),
      reviewContextMaxBytes: Type.Optional(
        Type.Integer({
          minimum: 1024,
          maximum: 8388608,
          description:
            "Review context resource allowance; default 200000 UTF-8 bytes. Increase explicitly when required without dropping obligations or resetting history.",
        }),
      ),
      verificationRepairReason: Type.Optional(
        Type.String({
          minLength: 1,
          maxLength: 4000,
          description:
            "Explicit command invocation repair after a failed/blocked previousAttempt (for example missing sh on Windows). Explain the failure and why coverage is equivalent. Preserve check names/order and success conditions, original obligations and baseline. Never bypass a failing test or weaken coverage.",
        }),
      ),
      input: Type.String({
        description:
          "Exact executor JSON with an operations array; authored by the agent",
      }),
      requirements: Type.Optional(
        Type.String({
          description:
            "Additional initial scope; inherited original obligations are assembled from persisted records. Omit on continuation and use structured contextUpdates.",
        }),
      ),
      baseRef: Type.Optional(
        Type.String({
          description:
            "Original task-start full 40-character Git SHA; resolved from the retained receipt on continuation",
        }),
      ),
      contextUpdates: Type.Optional(
        Type.Array(
          Type.Union([
            Type.Object(
              {
                kind: Type.Literal("apply_amendment"),
                reference: Type.String(),
                reason: Type.String(),
              },
              { additionalProperties: false },
            ),
            Type.Object(
              {
                kind: Type.Literal("add_obligation"),
                id: Type.Optional(Type.String()),
                text: Type.String(),
                findingId: Type.Optional(Type.String()),
                reason: Type.String(),
              },
              { additionalProperties: false },
            ),
            ...["annotate", "correct_assumption", "revise_design"].map((kind) =>
              Type.Object(
                {
                  kind: Type.Literal(kind),
                  text: Type.String(),
                  reason: Type.String(),
                },
                { additionalProperties: false },
              ),
            ),
            Type.Object(
              {
                kind: Type.Literal("propose_addressed"),
                findingId: Type.String(),
                reason: Type.String(),
              },
              { additionalProperties: false },
            ),
            Type.Object(
              {
                kind: Type.Literal("repair_check"),
                checkId: Type.String(),
                command: Type.Optional(
                  Type.Array(Type.String(), { minItems: 1 }),
                ),
                useMeaningfulTestEvaluator: Type.Optional(Type.Literal(true)),
                reason: Type.String(),
              },
              { additionalProperties: false },
            ),
            Type.Object(
              {
                kind: Type.Literal("add_check"),
                check: Type.Object(
                  {
                    name: Type.String(),
                    command: Type.Array(Type.String(), { minItems: 1 }),
                    successCondition: Type.Optional(
                      Type.Array(Type.String(), { minItems: 1 }),
                    ),
                  },
                  { additionalProperties: false },
                ),
                reason: Type.String(),
              },
              { additionalProperties: false },
            ),
            Type.Object(
              {
                kind: Type.Literal("diagnose"),
                text: Type.String(),
                signature: Type.String(),
                reason: Type.String(),
              },
              { additionalProperties: false },
            ),
          ]),
          {
            maxItems: 64,
            description:
              "Append-only discoveries/design annotations and verification repairs. Original criteria cannot be removed. Agent claims never independently verify findings.",
          },
        ),
      ),
      checkEnvironmentInputs: Type.Optional(
        Type.Object(
          {
            files: Type.Array(Type.String()),
            variables: Type.Array(Type.String()),
            executables: Type.Array(Type.String()),
          },
          {
            additionalProperties: false,
            description:
              "Complete relevant environment inputs for pure deterministic checks. Enables reuse only when source/index/HEAD, all definitions and measured inputs match. Omit when ambient state cannot be measured. Never include credentials.",
          },
        ),
      ),
      checks: Type.Optional(
        Type.Array(
          Type.Object(
            {
              name: Type.String({ minLength: 1, maxLength: 256 }),
              command: Type.Array(Type.String(), { minItems: 1, maxItems: 64 }),
              successCondition: Type.Optional(
                Type.Array(Type.String(), {
                  minItems: 1,
                  maxItems: 64,
                  description:
                    "Optional evaluator executable and arguments; Conductor supplies the original exit code and complete output paths via environment variables. Exit 0 permits the next command.",
                }),
              ),
            },
            { additionalProperties: false },
          ),
          {
            minItems: 1,
            maxItems: 64,
            description:
              "Ordered named verification commands for this task, using executable/argv arrays. Prefer targeted tests for leaves and scoped integration checks for intermediate parents. Exclude the full repository/workspace test command where targeted coverage is available; reserve the full suite for final root verification via validate_feature. Inspect output for actual coverage. The only supported verification format.  Required on the first attempt; continuations may omit it to inherit the retained verification plan. Revise commands through structured repairs; preserve required coverage and validators.",
          },
        ),
      ),
      reviewModel: Type.Optional(
        Type.String({
          description: "Independent review model; default opencode/gpt-6.1-sol",
        }),
      ),
      workflowTimeoutMs: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 2147483647,
          description:
            "Optional overall Conductor workflow deadline in milliseconds, covering execution, formatting, checks and review. " +
            "Defaults to 30 minutes. Maximum 2147483647 ms (~24.8 days). Independent of all review budgets.",
        }),
      ),
      reviewWallClockBudgetSecs: Type.Optional(
        Type.Integer({
          description:
            "Optional review wall-clock budget in seconds " +
            "(forwards to review-cli --wall-clock-budget-secs). Defaults to 180 seconds.",
        }),
      ),
      reviewMaxTurns: Type.Optional(
        Type.Integer({
          description:
            "Optional maximum model turns for review " +
            "(forwards to review-cli --max-turns). Defaults to 20 turns.",
        }),
      ),
      reviewMaxCostUsd: Type.Optional(
        Type.Number({
          description:
            "Optional review cost budget in USD " +
            "(forwards to review-cli --max-cost-usd). Omit for no cost cap.",
        }),
      ),
      reviewMaxToolCalls: Type.Optional(
        Type.Integer({
          description:
            "Optional maximum tool calls for review " +
            "(forwards to review-cli --max-tool-calls). Omit to use the review engine default.",
        }),
      ),
      reviewMaxRepeatedActions: Type.Optional(
        Type.Integer({
          description:
            "Optional maximum identical repeated tool calls before stalling " +
            "(forwards to review-cli --max-repeated-actions). Omit to use the review engine default.",
        }),
      ),
      reviewMaxCompletionAttempts: Type.Optional(
        Type.Integer({
          description:
            "Optional maximum completion attempts before stopping " +
            "(forwards to review-cli --max-completion-attempts). Omit to use the review engine default.",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const result = await executeAndCheckpoint(
        params,
        {
          directory: ctx.cwd,
          abort: signal,
        },
        { issueWorkflowOnly: true },
      );
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(executionSummary(result), null, 2),
          },
        ],
        isError: result.status === "BLOCKED",
        details: result,
      };
    },
  });
  pi.registerTool({
    name: "inspect_conductor_evidence",
    label: "Inspect retained Conductor evidence",
    description:
      "Read a content-addressed task receipt and compare its tree fingerprint. No writes or lifecycle transitions. Inspect check/review output before completing a task.",
    parameters: Type.Object({ reference: Type.String() }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await inspectEvidence(params.reference, {
        directory: ctx.cwd,
      });
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(result, null, 2) },
        ],
        isError: !result.ok,
        details: result,
      };
    },
  });
}

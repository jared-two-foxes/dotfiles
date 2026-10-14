/**
 * Pi's native execute_and_review tool.
 *
 * Pi and OpenCode have different extension APIs; both send the same
 * conductor.request/v1 protocol to the deterministic Rust Conductor CLI.
 * No direct executor/review-cli invocation or AI retry logic lives here.
 */
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { executeAndReview } from "./adapter.mjs";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "execute_and_review",
    label: "Execute and Review (Conductor)",
    description:
      "After explicit user approval, run ONE deterministic Conductor attempt: " +
      "apply exact executor operations, build, test and independently review. " +
      "Returns PASSED, NEEDS_DESIGN or BLOCKED. Never retries or generates fixes.",
    parameters: Type.Object({
      input: Type.String({
        description: "Exact executor JSON with an operations array; authored by the agent",
      }),
      requirements: Type.String({
        description: "Full approved design decisions and acceptance criteria",
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
}

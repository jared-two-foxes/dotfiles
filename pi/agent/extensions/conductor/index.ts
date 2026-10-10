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

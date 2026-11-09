import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { featureAuthorized } from "../scaffold/feature-authorization.mjs";
import { rewriteFeatureHistory } from "./reconciliation.mjs";
import { adoptCommits, inspectDrift } from "./foreign-history.mjs";
import { suspendIssue, resumeIssue } from "./issue-recovery.mjs";
import { prepareIssueHandoff, inspectIssueHandoff, inspectIssueAttempt } from "./issue-context.mjs";

export default function (pi: ExtensionAPI) {
  for (const operation of ["suspend", "resume"] as const)
    pi.registerTool({
      name: operation === "suspend" ? "suspend_issue" : "resume_issue",
      label:
        operation === "suspend"
          ? "Suspend issue for design"
          : "Restore suspended issue",
      description:
        operation === "suspend"
          ? "Explicitly park an unfinished recursive issue using saved Git snapshots/stash and return its graph to design. Preserves index, untracked files, receipts and consumed attempts. Without previousAttempt, requires clean source and no existing attempt receipts (zero attempts consumed). Uses the retained overall feature authorization. Never marks implementation verified."
          : "Restore saved issue work onto authenticated completed prerequisite checkpoints and retain a baseline handoff without resetting attempts. Uses the retained overall feature authorization. A conflict blocks and preserves saved work. READY is not PASSED; start the same issue and continue within the approved feature direction. Zero-attempt handoffs require freshly supplied verification commands.",
      parameters: Type.Object(
        {
          task: Type.Object({
            featureId: Type.String(),
            taskId: Type.String(),
            designRef: Type.String(),
          }),
          branch: Type.String(),
          featureBaseRef: Type.String(),
          defaultBranch: Type.String(),
          protectedBranches: Type.Array(Type.String()),
          ...(operation === "suspend"
            ? {
                previousAttempt: Type.Optional(Type.String()),
                reason: Type.String(),
                suspensionRef: Type.Optional(Type.String()),
              }
            : {
                suspensionRef: Type.String(),
                handoffRef: Type.Optional(Type.String()),
              }),
        },
        { additionalProperties: false },
      ),
      async execute(_id, params, signal, _update, ctx) {
        const result = await (
          operation === "suspend" ? suspendIssue : resumeIssue
        )(
          params,
          { directory: ctx.cwd, abort: signal },
          {
            authorize: async () =>
              featureAuthorized(params, { directory: ctx.cwd, abort: signal }),
          },
        );
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(result, null, 2) },
          ],
          isError: result.status === "BLOCKED",
          details: result,
        };
      },
    });
  pi.registerTool({
    name: "prepare_issue_handoff",
    label: "Prepare issue context",
    description:
      "Persist scoped issue context bound to current graph, Git source/index/HEAD and authenticated latest attempt. Context only; no source execution, approval or lifecycle authority. Returns a reference for a fresh session.",
    parameters: Type.Object(
      {
        featureId: Type.String(),
        taskId: Type.String(),
        notes: Type.Optional(
          Type.Object(
            {
              next_action: Type.Optional(Type.String()),
              source_locations: Type.Optional(Type.Array(Type.String())),
              open_questions: Type.Optional(Type.Array(Type.String())),
            },
            { additionalProperties: false },
          ),
        ),
      },
      { additionalProperties: false },
    ),
    async execute(_id, params, signal, _update, ctx) {
      const result = await prepareIssueHandoff(params, {
        directory: ctx.cwd,
        abort: signal,
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
        details: result,
        isError: !result.ok || !result.applicable,
      };
    },
  });
  for (const [name, inspect] of [
    ["inspect_issue_handoff", inspectIssueHandoff],
    ["inspect_issue_attempt", inspectIssueAttempt],
  ] as const)
    pi.registerTool({
      name,
      label:
        name === "inspect_issue_handoff"
          ? "Resume issue context"
          : "Inspect issue continuation",
      description:
        name === "inspect_issue_handoff"
          ? "Read persisted issue context and reauthenticate applicability. Stale handoffs return a refresh instruction, never current context. Grants no execution authority."
          : "Read authenticated versioned context, checks and invocation sequence by receipt reference, without executor input, raw logs or historical request dumps. Grants no approval or execution authority.",
      parameters:
        name === "inspect_issue_handoff"
          ? Type.Object(
              {
                reference: Type.Optional(Type.String()),
                featureId: Type.Optional(Type.String()),
                taskId: Type.Optional(Type.String()),
              },
              { additionalProperties: false },
            )
          : Type.Object(
              { reference: Type.String() },
              { additionalProperties: false },
            ),
      async execute(_id, params, signal, _update, ctx) {
        const result = await inspect(params, {
          directory: ctx.cwd,
          abort: signal,
        });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
          details: result,
          isError: !result.ok,
        };
      },
    });
  pi.registerTool({
    name: "rewrite_feature_history",
    label: "Verify and record a rebase",
    description:
      "Recovery after a user-performed rebase of the feature branch BETWEEN tasks (suspend any active task first). Requires a clean feature branch, the ledger's recorded head, the new upstream base, and fresh approved full-project checks plus independent review of the rebased result. Maps every recorded checkpoint and foreign commit onto the rebased commits (none dropped, squashed, split, reordered or added), then records a history-rewrite entry; the previous history stays in the ledger. Never rebases, edits Git or changes task status. Not for commits the ledger has not recorded (use adopt_foreign_commits).",
    parameters: Type.Object({
      featureId: Type.String(),
      designRef: Type.String(),
      branch: Type.String(),
      oldHeadRef: Type.String({ description: "The head the ledger currently records (full SHA)" }),
      upstreamBaseRef: Type.String({ description: "The commit the branch was rebased onto (full SHA)" }),
      headRef: Type.String({ description: "Current HEAD after the rebase (full SHA)" }),
      defaultBranch: Type.String(),
      protectedBranches: Type.Array(Type.String()),
      resumeEvidenceRef: Type.Optional(Type.String()),
      buildCommand: Type.Array(Type.String(), { minItems: 1 }),
      testCommand: Type.Array(Type.String(), { minItems: 1 }),
      testSuccessPattern: Type.String(),
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
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const result = await rewriteFeatureHistory(params, { directory: ctx.cwd, abort: signal }, {});
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(result, null, 2) },
        ],
        isError: result.status === "BLOCKED",
        details: result,
      };
    },
  });
  pi.registerTool({
    name: "adopt_foreign_commits",
    label: "Record user commits in the ledger",
    description:
      "After the user committed changes that are not verified task checkpoints (for example unrelated files committed to clear a dirty tree), record them in the Scaffold ledger between tasks. Requires explicit user approval naming the recorded head and the new head, a clean tree and index, and no active task. Records a history-foreign entry: the commits are NOT verified, are never treated as task checkpoints, and remain in final-validation review scope. Idempotent. Not rebase recovery; never edits Scaffold or rewrites Git. Use inspect_feature_drift first.",
    parameters: Type.Object(
      {
        featureId: Type.String(),
        fromRef: Type.String({ description: "The head the ledger currently records (full SHA)" }),
        toRef: Type.String({ description: "Current clean HEAD to record (full SHA)" }),
      },
      { additionalProperties: false },
    ),
    async execute(_id, params, signal, _update, ctx) {
      const result = await adoptCommits(
        params,
        { directory: ctx.cwd, abort: signal },
        {
          confirm: async (scope) =>
            ctx.hasUI === true &&
            (await ctx.ui.confirm(
              "Record " + scope.commits.length + " commit(s) up to " + scope.to.slice(0, 12) + " (ledger head is " + scope.from.slice(0, 12) + ")?",
              JSON.stringify(scope, null, 2) +
                "\nThese commits are NOT verified task checkpoints. They stay in the final validation review scope. The original baseline, approval and designs are unchanged. This grants no other permission.",
            )),
        },
      );
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        isError: result.ok === false,
        details: result,
      };
    },
  });
  pi.registerTool({
    name: "inspect_feature_drift",
    label: "Inspect feature drift",
    description:
      "Read-only. Classifies how Git relates to the history the Scaffold ledger recorded (authenticated, foreign commits, dirty tree, rewritten history, ledger disagrees with Git, interrupted Git operation, upstream behind) and names the one applicable recovery. Never changes Git, Scaffold or evidence.",
    parameters: Type.Object({ featureId: Type.String() }, { additionalProperties: false }),
    async execute(_id, params, signal, _update, ctx) {
      const result = await inspectDrift(params, { directory: ctx.cwd, abort: signal });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        isError: result.ok === false,
        details: result,
      };
    },
  });
}

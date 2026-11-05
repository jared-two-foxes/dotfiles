import { Type } from "typebox";
import { finalizeVerifiedTask } from "../../lib/delivery-state/checkpoint-recovery.mjs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { featureAuthorized } from "../../lib/scaffold/feature-authorization.mjs";
import { reconcileFeature, inspectReconciliation } from "./reconciliation.mjs";
import {
  recoverInterruptedTaskRebase,
  inspectTaskRebaseRecovery,
} from "./interrupted-rebase.mjs";
import { suspendIssue, resumeIssue } from "./issue-recovery.mjs";
import {
  prepareIssueHandoff,
  inspectIssueHandoff,
  inspectIssueAttempt,
} from "../../lib/delivery-state/issue-context.mjs";

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
          reconciliationRef: Type.Optional(Type.String()),
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
    name: "recover_interrupted_task_rebase",
    label: "Recover interrupted task after rebase",
    description:
      "Explicit recovery of an active/blocked/failed task after rebase. Preserve current files/index, old receipt chain, criteria/findings and consumed attempts. Verify only the completed prefix in a disposable worktree, then retain a non-PASSED handoff for execute_and_review.previousAttempt. No source writes, stash/reset, task lifecycle changes or attempt reset. Requires narrow UI authorization; next source correction remains within the approved feature direction.",
    parameters: Type.Object({
      task: Type.Object({
        featureId: Type.String(),
        taskId: Type.String(),
        designRef: Type.String(),
      }),
      previousAttempt: Type.String({
        description:
          "Latest retained receipt of the interrupted task; all consumed attempts must remain linked",
      }),
      featureId: Type.String(),
      designRef: Type.String(),
      branch: Type.String(),
      featureBaseRef: Type.String(),
      oldHeadRef: Type.String(),
      upstreamBaseRef: Type.String(),
      headRef: Type.String(),
      defaultBranch: Type.String(),
      protectedBranches: Type.Array(Type.String()),
      previousReconciliationRef: Type.Optional(Type.String()),
      prefixEvidenceRef: Type.Optional(Type.String()),
      resumeHandoffRef: Type.Optional(Type.String()),
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
      const result = await recoverInterruptedTaskRebase(
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
    name: "inspect_task_rebase_recovery",
    label: "Inspect interrupted task rebase handoff",
    description:
      "Authenticate retained task rebase handoff, consumed attempts, completed-prefix evidence and current applicability. Read only; READY never means task verification passed.",
    parameters: Type.Object({ reference: Type.String() }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const result = await inspectTaskRebaseRecovery(params, {
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
  pi.registerTool({
    name: "reconcile_feature_rebase",
    label: "Verify feature after rebase",
    description:
      "Verification-only recovery after a user-performed rebase BETWEEN tasks. Requires clean feature branch, original checkpoint history and fresh approved full-project checks plus independent review. Preserves original design/receipts; never rebases, edits, commits or changes Scaffold task status. Retain returned evidenceRef for checkpoint_verified_task and validate_feature.",
    parameters: Type.Object({
      featureId: Type.String(),
      designRef: Type.String(),
      branch: Type.String(),
      featureBaseRef: Type.String(),
      oldHeadRef: Type.String(),
      upstreamBaseRef: Type.String(),
      headRef: Type.String(),
      defaultBranch: Type.String(),
      protectedBranches: Type.Array(Type.String()),
      previousReconciliationRef: Type.Optional(Type.String()),
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
      const result = await reconcileFeature(
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
    name: "inspect_rebase_reconciliation",
    label: "Inspect retained rebase reconciliation",
    description:
      "Discover and authenticate local rebase receipts against current Git and Scaffold state. Read only; no checks, review, source or lifecycle writes.",
    parameters: Type.Object({
      featureId: Type.Optional(Type.String()),
      reference: Type.Optional(Type.String()),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const result = await inspectReconciliation(params, {
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
  pi.registerTool({
    name: "checkpoint_verified_task",
    label: "Checkpoint verified task",
    description:
      "Recover automatic finalization using a successful implementation receipt: record matching Scaffold completion if needed, then create or recover ONE commit of the exact reviewed tree through Conductor. Never reapply operations or rerun review to recover a failed commit. Uses retained feature authority.",
    parameters: Type.Object({
      task: Type.Object({
        featureId: Type.String(),
        taskId: Type.String(),
        designRef: Type.String(),
      }),
      evidenceRef: Type.String(),
      reconciliationRef: Type.Optional(
        Type.String({
          description:
            "Latest successful rebase reconciliation evidence, if history was rewritten",
        }),
      ),
      featureBaseRef: Type.String({
        description:
          "Original feature-start SHA, preserved across all task checkpoints",
      }),
      branch: Type.String({
        description: "Explicit authorized feature branch",
      }),
      defaultBranch: Type.String({
        description: "Known actual repository default branch",
      }),
      protectedBranches: Type.Array(Type.String(), {
        description: "All additional known protected branches; [] if none",
      }),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const result = await finalizeVerifiedTask(params, {
        directory: ctx.cwd,
        abort: signal,
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

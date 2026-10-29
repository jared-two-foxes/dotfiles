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
import { reconcileFeature, inspectReconciliation } from "./reconciliation.mjs";
import { recoverInterruptedTaskRebase, inspectTaskRebaseRecovery } from "./interrupted-rebase.mjs";
import { suspendIssue, resumeIssue } from "./issue-recovery.mjs";
import { prepareIssueHandoff, inspectIssueHandoff, inspectIssueAttempt } from "./issue-context.mjs";
import { inspectEvidence } from "./evidence.mjs";

export default function (pi: ExtensionAPI) {
  let checkpointContext: ExtensionContext | undefined;
  const confirmation = async (title: string, message: string) =>
    checkpointContext?.hasUI === true && await checkpointContext.ui.confirm(title, message);
  const authorizeCheckpoint = checkpointAuthorization(confirmation);
  pi.on("session_start", async () => { authorizeCheckpoint.reset(); });
  for (const operation of ["suspend", "resume"] as const) pi.registerTool({
    name: operation === "suspend" ? "suspend_issue" : "resume_issue",
    label: operation === "suspend" ? "Suspend issue for design" : "Restore suspended issue",
    description: operation === "suspend"
      ? "Explicitly park an unfinished recursive issue using saved Git snapshots/stash and return its graph to design. Preserves index, untracked files, receipts and consumed attempts. Without previousAttempt, requires clean source and no existing attempt receipts (zero attempts consumed). Requires UI authorization. Never marks implementation verified."
      : "Restore saved issue work onto authenticated completed prerequisite checkpoints and retain a baseline handoff without resetting attempts. Requires UI authorization. A conflict blocks and preserves saved work. READY is not PASSED; start the same issue and obtain normal execution approval. Zero-attempt handoffs require freshly supplied verification commands.",
    parameters: Type.Object({
      task: Type.Object({ featureId: Type.String(), taskId: Type.String(), designRef: Type.String() }),
      branch: Type.String(), featureBaseRef: Type.String(), defaultBranch: Type.String(),
      protectedBranches: Type.Array(Type.String()), reconciliationRef: Type.Optional(Type.String()),
      ...(operation === "suspend" ? {
        previousAttempt: Type.Optional(Type.String()), reason: Type.String(), suspensionRef: Type.Optional(Type.String()),
      } : { suspensionRef: Type.String(), handoffRef: Type.Optional(Type.String()) }),
    }, { additionalProperties: false }),
    async execute(_id, params, signal, _update, ctx) {
      const result = await (operation === "suspend" ? suspendIssue : resumeIssue)(params,
        { directory: ctx.cwd, abort: signal }, { authorize: async scope => ctx.hasUI === true &&
          await ctx.ui.confirm(operation === "suspend" ? "Park issue and return to design?" : "Restore suspended issue?", JSON.stringify(scope, null, 2)) });
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        isError: result.status === "BLOCKED", details: result };
    },
  });
  pi.registerTool({
    name: "prepare_issue_handoff", label: "Prepare issue context",
    description: "Persist scoped issue context bound to current graph, Git source/index/HEAD and authenticated latest attempt. Context only; no source execution, approval or lifecycle authority. Returns a reference for a fresh session.",
    parameters: Type.Object({ featureId: Type.String(), taskId: Type.String(), notes: Type.Optional(Type.Object({
      next_action: Type.Optional(Type.String()), source_locations: Type.Optional(Type.Array(Type.String())),
      open_questions: Type.Optional(Type.Array(Type.String())),
    }, { additionalProperties: false })) }, { additionalProperties: false }),
    async execute(_id, params, signal, _update, ctx) {
      const result = await prepareIssueHandoff(params, { directory: ctx.cwd, abort: signal });
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: result, isError: !result.ok || !result.applicable };
    },
  });
  for (const [name, inspect] of [["inspect_issue_handoff", inspectIssueHandoff], ["inspect_issue_attempt", inspectIssueAttempt]] as const) pi.registerTool({
    name, label: name === "inspect_issue_handoff" ? "Resume issue context" : "Inspect issue continuation",
    description: name === "inspect_issue_handoff" ? "Read persisted issue context and reauthenticate applicability. Stale handoffs return a refresh instruction, never current context. Grants no execution authority."
      : "Read authenticated fixed continuation requirements, checks and attempt count by receipt reference, without executor input, raw logs or historical request dumps. Grants no approval or execution authority.",
    parameters: name === "inspect_issue_handoff" ? Type.Object({ reference: Type.Optional(Type.String()), featureId: Type.Optional(Type.String()), taskId: Type.Optional(Type.String()) }, { additionalProperties: false }) : Type.Object({ reference: Type.String() }, { additionalProperties: false }),
    async execute(_id, params, signal, _update, ctx) {
      const result = await inspect(params, { directory: ctx.cwd, abort: signal });
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: result, isError: !result.ok };
    },
  });
  pi.registerTool({
    name: "recover_interrupted_task_rebase",
    label: "Recover interrupted task after rebase",
    description: "Explicit recovery of an active/blocked/failed task after rebase. Preserve current files/index, old receipt chain, criteria/findings and consumed attempts. Verify only the completed prefix in a disposable worktree, then retain a non-PASSED handoff for execute_and_review.previousAttempt. No source writes, stash/reset, task lifecycle changes or attempt reset. Requires narrow UI authorization; next source correction needs normal execution approval.",
    parameters: Type.Object({
      task: Type.Object({ featureId: Type.String(), taskId: Type.String(), designRef: Type.String() }),
      previousAttempt: Type.String({ description: "Latest retained receipt of the interrupted task; all consumed attempts must remain linked" }),
      featureId: Type.String(), designRef: Type.String(), branch: Type.String(),
      featureBaseRef: Type.String(), oldHeadRef: Type.String(), upstreamBaseRef: Type.String(), headRef: Type.String(),
      defaultBranch: Type.String(), protectedBranches: Type.Array(Type.String()),
      previousReconciliationRef: Type.Optional(Type.String()), prefixEvidenceRef: Type.Optional(Type.String()),
      resumeHandoffRef: Type.Optional(Type.String()),
      buildCommand: Type.Array(Type.String(), { minItems: 1 }),
      testCommand: Type.Array(Type.String(), { minItems: 1 }), testSuccessPattern: Type.String(),
      integrationChecks: Type.Optional(Type.Array(Type.Object({
        name: Type.String(), command: Type.Array(Type.String(), { minItems: 1 }), successPattern: Type.String(),
      }))),
      checkTimeoutMs: Type.Optional(Type.Integer()),
      review: Type.Optional(Type.Object({
        model: Type.Optional(Type.String()), wallClockBudgetSecs: Type.Optional(Type.Integer()),
        maxTurns: Type.Optional(Type.Integer()), maxCostUsd: Type.Optional(Type.Number()), maxToolCalls: Type.Optional(Type.Integer()),
        maxRepeatedActions: Type.Optional(Type.Integer()), maxCompletionAttempts: Type.Optional(Type.Integer()),
      })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const result = await recoverInterruptedTaskRebase(params, { directory: ctx.cwd, abort: signal }, {
        authorize: async scope => ctx.hasUI === true && await ctx.ui.confirm("Authorize interrupted task rebase recovery",
          JSON.stringify(scope, null, 2) + "\nVerify the completed prefix in a disposable worktree and retain an explicit new-baseline handoff for this unfinished task? Preserve all source/index changes, criteria, findings and consumed attempts. This grants verification, temporary worktree and evidence/audit-ref authority only. No source correction, stash/reset, branch changes, task transitions or publishing."),
      });
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }], isError: result.status === "BLOCKED", details: result };
    },
  });
  pi.registerTool({
    name: "inspect_task_rebase_recovery",
    label: "Inspect interrupted task rebase handoff",
    description: "Authenticate retained task rebase handoff, consumed attempts, completed-prefix evidence and current applicability. Read only; READY never means task verification passed.",
    parameters: Type.Object({ reference: Type.String() }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const result = await inspectTaskRebaseRecovery(params, { directory: ctx.cwd });
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }], isError: !result.ok, details: result };
    },
  });
  pi.registerTool({
    name: "reconcile_feature_rebase",
    label: "Verify feature after rebase",
    description: "Verification-only recovery after a user-performed rebase BETWEEN tasks. Requires clean feature branch, original checkpoint history and fresh approved full-project checks plus independent review. Preserves original design/receipts; never rebases, edits, commits or changes Scaffold task status. Retain returned evidenceRef for checkpoint_verified_task and validate_feature.",
    parameters: Type.Object({
      featureId: Type.String(), designRef: Type.String(), branch: Type.String(),
      featureBaseRef: Type.String(), oldHeadRef: Type.String(), upstreamBaseRef: Type.String(), headRef: Type.String(),
      defaultBranch: Type.String(), protectedBranches: Type.Array(Type.String()),
      previousReconciliationRef: Type.Optional(Type.String()), resumeEvidenceRef: Type.Optional(Type.String()),
      buildCommand: Type.Array(Type.String(), { minItems: 1 }),
      testCommand: Type.Array(Type.String(), { minItems: 1 }), testSuccessPattern: Type.String(),
      integrationChecks: Type.Optional(Type.Array(Type.Object({
        name: Type.String(), command: Type.Array(Type.String(), { minItems: 1 }), successPattern: Type.String(),
      }))),
      checkTimeoutMs: Type.Optional(Type.Integer()),
      review: Type.Optional(Type.Object({
        model: Type.Optional(Type.String()), wallClockBudgetSecs: Type.Optional(Type.Integer()),
        maxTurns: Type.Optional(Type.Integer()), maxCostUsd: Type.Optional(Type.Number()), maxToolCalls: Type.Optional(Type.Integer()),
        maxRepeatedActions: Type.Optional(Type.Integer()), maxCompletionAttempts: Type.Optional(Type.Integer()),
      })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const result = await reconcileFeature(params, { directory: ctx.cwd, abort: signal }, {
        authorize: async scope => ctx.hasUI === true && await ctx.ui.confirm("Authorize verification after rebase",
          JSON.stringify(scope, null, 2) + "\nRun these full-project checks and independent review of the rebased completed tasks? Verification/evidence only. No source editing, Git history changes, commits, publishing or task lifecycle changes."),
      });
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }], isError: result.status === "BLOCKED", details: result };
    },
  });
  pi.registerTool({
    name: "inspect_rebase_reconciliation",
    label: "Inspect retained rebase reconciliation",
    description: "Discover and authenticate local rebase receipts against current Git and Scaffold state. Read only; no checks, review, source or lifecycle writes.",
    parameters: Type.Object({ featureId: Type.Optional(Type.String()), reference: Type.Optional(Type.String()) }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const result = await inspectReconciliation(params, { directory: ctx.cwd });
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }], isError: !result.ok, details: result };
    },
  });
  pi.registerTool({
    name: "validate_feature",
    label: "Validate complete feature",
    description: "Verification-only final gate: authenticate all task checkpoints, run approved full-project checks, independently review the original baseline through final HEAD, retain evidence and record Scaffold validation. Requires narrow Pi UI authorization. No implementation, commits, publishing, retries or task selection.",
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
      reconciliationRef: Type.Optional(Type.String({ description: "Latest successful rebase reconciliation evidence, if history was rewritten" })),
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
      "apply exact executor operations, run caller-selected verification and independently review. " +
      "Returns PASSED, NEEDS_DESIGN or BLOCKED. Never retries or generates fixes.",
    parameters: Type.Object({
      reconciliationRef: Type.Optional(Type.String({ description: "Verified rebase anchor for recursive issue execution" })),
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
      checks: Type.Optional(Type.Array(Type.Object({
        name: Type.String({ minLength: 1, maxLength: 256 }),
        command: Type.Array(Type.String(), { minItems: 1, maxItems: 64 }),
      }, { additionalProperties: false }), {
        minItems: 1, maxItems: 64,
        description: "Ordered named verification commands for this task, using executable/argv arrays. Select meaningful targeted tests and other checks; inspect output for actual coverage. Supply checks OR both legacy buildCommand/testCommand fields. The plan stays fixed across corrections.",
      })),
      buildCommand: Type.Optional(Type.Array(Type.String(), { minItems: 1, description: "Legacy build executable and arguments; use with testCommand and omit checks" })),
      testCommand: Type.Optional(Type.Array(Type.String(), { minItems: 1, description: "Legacy test executable and arguments; targeted test filters are supported; omit when supplying checks" })),
      reviewModel: Type.Optional(Type.String({
        description: "Independent review model; default opencode/gpt-6.1-sol",
      })),
      workflowTimeoutMs: Type.Optional(Type.Integer({
        minimum: 1,
        maximum: 2147483647,
        description:
          "Optional overall Conductor workflow deadline in milliseconds, covering execution, formatting, checks and review. " +
          "Defaults to 30 minutes. Maximum 2147483647 ms (~24.8 days). Independent of all review budgets.",
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
      }, { issueWorkflowOnly: true });
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

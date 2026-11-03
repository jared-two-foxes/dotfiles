/**
 * Pi's native execute_and_review tool.
 *
 * Sends the
 * conductor.request/v2 command-list protocol to the deterministic Rust Conductor CLI.
 * The feature gate reuses bounded Review without Executor or AI retry logic.
 */
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { executeAndCheckpoint, finalizeVerifiedTask } from "./delivery.mjs";
import { executionSummary } from "./protocol.mjs";
import { validateFeature, inspectFeatureValidation } from "./feature.mjs";
import { reconcileFeature, inspectReconciliation } from "./reconciliation.mjs";
import { recoverInterruptedTaskRebase, inspectTaskRebaseRecovery } from "./interrupted-rebase.mjs";
import { suspendIssue, resumeIssue } from "./issue-recovery.mjs";
import { prepareIssueHandoff, inspectIssueHandoff, inspectIssueAttempt } from "./issue-context.mjs";
import { approveFeatureDirection, featureAuthorized } from "./feature-authorization.mjs";
import { inspectEvidence } from "./evidence.mjs";
import { approveDeliveryAmendment } from "./context-amendment.mjs";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "approve_delivery_amendment", label: "Approve material contract amendment",
    description: "Explicit user approval of a concrete material scope/criterion/finding delta. Retains original obligations, source, authorization and all execution history. Routine corrections do not use this tool. Apply the returned reference through contextUpdates.apply_amendment; approval never establishes verification.",
    parameters: Type.Object({ previousAttempt: Type.String(), ids: Type.Array(Type.String(), { minItems: 1 }),
      replacement: Type.String({ minLength: 1 }), reason: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
    async execute(_id, params, signal, _update, ctx) {
      const result = await approveDeliveryAmendment(params, { directory: ctx.cwd, abort: signal }, {
        confirm: async scope => ctx.hasUI === true && await ctx.ui.confirm("Approve this material contract change?",
          JSON.stringify(scope, null, 2) + "\nOriginal obligations and all execution history remain retained. Only this concrete delta is authorized; independent verification is still required."),
      });
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: result, isError: !result.ok };
    },
  });
  pi.registerTool({
    name: "approve_feature_direction", label: "Approve feature direction",
    description: "The single approval for this feature's direction and local delivery loop. Persists authority for scoped design, implementation, checks, independent review, checkpoints and recovery across sessions. No per-issue confirmations. Does not authorize publishing, merging or changing the approved objectives/constraints.",
    parameters: Type.Object({ featureId: Type.String() }, { additionalProperties: false }),
    async execute(_id, params, signal, _update, ctx) {
      const result = await approveFeatureDirection(params, { directory: ctx.cwd, abort: signal }, {
        confirm: async scope => ctx.hasUI === true && await ctx.ui.confirm("Approve overall design direction and implementation?",
          JSON.stringify(scope, null, 2) + "\nProceed with this feature through design, implementation, checks, independent review, local checkpoints and recovery without further routine confirmations? Stop for changes outside this approved direction. Publishing and merging are separate."),
      });
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: result, isError: !result.ok };
    },
  });
  for (const operation of ["suspend", "resume"] as const) pi.registerTool({
    name: operation === "suspend" ? "suspend_issue" : "resume_issue",
    label: operation === "suspend" ? "Suspend issue for design" : "Restore suspended issue",
    description: operation === "suspend"
      ? "Explicitly park an unfinished recursive issue using saved Git snapshots/stash and return its graph to design. Preserves index, untracked files, receipts and consumed attempts. Without previousAttempt, requires clean source and no existing attempt receipts (zero attempts consumed). Uses the retained overall feature authorization. Never marks implementation verified."
      : "Restore saved issue work onto authenticated completed prerequisite checkpoints and retain a baseline handoff without resetting attempts. Uses the retained overall feature authorization. A conflict blocks and preserves saved work. READY is not PASSED; start the same issue and continue within the approved feature direction. Zero-attempt handoffs require freshly supplied verification commands.",
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
        { directory: ctx.cwd, abort: signal }, { authorize: async () => featureAuthorized(params, { directory: ctx.cwd, abort: signal }) });
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
      : "Read authenticated versioned context, checks and invocation sequence by receipt reference, without executor input, raw logs or historical request dumps. Grants no approval or execution authority.",
    parameters: name === "inspect_issue_handoff" ? Type.Object({ reference: Type.Optional(Type.String()), featureId: Type.Optional(Type.String()), taskId: Type.Optional(Type.String()) }, { additionalProperties: false }) : Type.Object({ reference: Type.String() }, { additionalProperties: false }),
    async execute(_id, params, signal, _update, ctx) {
      const result = await inspect(params, { directory: ctx.cwd, abort: signal });
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: result, isError: !result.ok };
    },
  });
  pi.registerTool({
    name: "recover_interrupted_task_rebase",
    label: "Recover interrupted task after rebase",
    description: "Explicit recovery of an active/blocked/failed task after rebase. Preserve current files/index, old receipt chain, criteria/findings and consumed attempts. Verify only the completed prefix in a disposable worktree, then retain a non-PASSED handoff for execute_and_review.previousAttempt. No source writes, stash/reset, task lifecycle changes or attempt reset. Requires narrow UI authorization; next source correction remains within the approved feature direction.",
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
        authorize: async () => featureAuthorized(params, { directory: ctx.cwd, abort: signal }),
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
        authorize: async () => featureAuthorized(params, { directory: ctx.cwd, abort: signal }),
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
  pi.registerTool({
    name: "checkpoint_verified_task",
    label: "Checkpoint verified task",
    description: "Recover automatic finalization using a successful implementation receipt: record matching Scaffold completion if needed, then create or recover ONE commit of the exact reviewed tree through Conductor. Never reapply operations or rerun review to recover a failed commit. Uses retained feature authority.",
    parameters: Type.Object({
      task: Type.Object({ featureId: Type.String(), taskId: Type.String(), designRef: Type.String() }),
      evidenceRef: Type.String(),
      reconciliationRef: Type.Optional(Type.String({ description: "Latest successful rebase reconciliation evidence, if history was rewritten" })),
      featureBaseRef: Type.String({ description: "Original feature-start SHA, preserved across all task checkpoints" }),
      branch: Type.String({ description: "Explicit authorized feature branch" }),
      defaultBranch: Type.String({ description: "Known actual repository default branch" }),
      protectedBranches: Type.Array(Type.String(), { description: "All additional known protected branches; [] if none" }),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const result = await finalizeVerifiedTask(params, { directory: ctx.cwd, abort: signal });
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        isError: !result.ok, details: result };
    },
  });
  pi.registerTool({
    name: "execute_and_review",
    label: "Execute and Review (Conductor)",
    description:
      "Under the approved feature direction, construct and run ONE Conductor v2 command list: " +
      "external Executor, caller-selected verification, then external Review. After approval, automatically record task completion and run a verified Git commit command through Conductor. " +
      "Returns PASSED, NEEDS_DESIGN or BLOCKED. One call never retries or generates fixes; Pi diagnoses recoverable failures and continues with the latest previousAttempt against its retained after-tree. Use empty operations for verification-only retries.",
    parameters: Type.Object({
      checkpoint: Type.Optional(Type.Object({
        defaultBranch: Type.String({ description: "Known repository default branch; protected from automatic commits" }),
        protectedBranches: Type.Array(Type.String(), { description: "All additional known protected branches, or []" }),
      }, { additionalProperties: false, description: "Automatic post-review local commit context; branch and original baseline come from the approved feature; inherited on continuation" })),
      reconciliationRef: Type.Optional(Type.String({ description: "Verified rebase anchor for recursive issue execution" })),
      task: Type.Optional(Type.Object({
        featureId: Type.String(), taskId: Type.String(), designRef: Type.String(),
      }, { description: "Scaffold task identity and approved immutable design reference" })),
      previousAttempt: Type.Optional(Type.String({
        description: "Retained receipt for the previous attempt of this same task; required for corrections/recovery",
      })),
      reviewProbe: Type.Optional(Type.Boolean({ description: "Explicit bounded no-source health probe after environment-only credential repair. A failed probe is throttled for five minutes; no assertion of repair grants approval." })),
      reviewContextMaxBytes: Type.Optional(Type.Integer({ minimum: 1024, maximum: 8388608,
        description: "Review context resource allowance; default 200000 UTF-8 bytes. Increase explicitly when required without dropping obligations or resetting history." })),
      verificationRepairReason: Type.Optional(Type.String({ minLength: 1, maxLength: 4000,
        description: "Explicit command invocation repair after a failed/blocked previousAttempt (for example missing sh on Windows). Explain the failure and why coverage is equivalent. Preserve check names/order and success conditions, original obligations and baseline. Never bypass a failing test or weaken coverage.",
      })),
      input: Type.String({
        description: "Exact executor JSON with an operations array; authored by the agent",
      }),
      requirements: Type.Optional(Type.String({
        description: "Additional initial scope; inherited original obligations are assembled from persisted records. Omit on continuation and use structured contextUpdates.",
      })),
      baseRef: Type.Optional(Type.String({
        description: "Original task-start full 40-character Git SHA; resolved from previousAttempt on continuation",
      })),
      contextUpdates: Type.Optional(Type.Array(Type.Union([
        Type.Object({ kind: Type.Literal("apply_amendment"), reference: Type.String(), reason: Type.String() }, { additionalProperties: false }),
        Type.Object({ kind: Type.Literal("add_obligation"), id: Type.Optional(Type.String()),
          text: Type.String(), findingId: Type.Optional(Type.String()), reason: Type.String() }, { additionalProperties: false }),
        ...["annotate", "correct_assumption", "revise_design"].map(kind => Type.Object({
          kind: Type.Literal(kind), text: Type.String(), reason: Type.String() }, { additionalProperties: false })),
        Type.Object({ kind: Type.Literal("propose_addressed"), findingId: Type.String(), reason: Type.String() }, { additionalProperties: false }),
        Type.Object({ kind: Type.Literal("repair_check"), checkId: Type.String(), command: Type.Array(Type.String(), { minItems: 1 }), reason: Type.String() }, { additionalProperties: false }),
        Type.Object({ kind: Type.Literal("add_check"), check: Type.Object({ name: Type.String(), command: Type.Array(Type.String(), { minItems: 1 }),
          successCondition: Type.Optional(Type.Array(Type.String(), { minItems: 1 })) }, { additionalProperties: false }), reason: Type.String() }, { additionalProperties: false }),
        Type.Object({ kind: Type.Literal("diagnose"), text: Type.String(), signature: Type.String(), reason: Type.String() }, { additionalProperties: false }),
      ]), { maxItems: 64, description: "Append-only discoveries/design annotations and verification repairs. Original criteria cannot be removed. Agent claims never independently verify findings." })),
      checkEnvironmentInputs: Type.Optional(Type.Object({
        files: Type.Array(Type.String()), variables: Type.Array(Type.String()), executables: Type.Array(Type.String()),
      }, { additionalProperties: false, description: "Complete relevant environment inputs for pure deterministic checks. Enables reuse only when source/index/HEAD, all definitions and measured inputs match. Omit when ambient state cannot be measured. Never include credentials." })),
      checks: Type.Optional(Type.Array(Type.Object({
        name: Type.String({ minLength: 1, maxLength: 256 }),
        command: Type.Array(Type.String(), { minItems: 1, maxItems: 64 }),
        successCondition: Type.Optional(Type.Array(Type.String(), { minItems: 1, maxItems: 64,
          description: "Optional evaluator executable and arguments; Conductor supplies the original exit code and complete output paths via environment variables. Exit 0 permits the next command." })),
      }, { additionalProperties: false }), {
        minItems: 1, maxItems: 64,
        description: "Ordered named verification commands for this task, using executable/argv arrays. Prefer targeted tests for leaves and scoped integration checks for intermediate parents. Exclude the full repository/workspace test command where targeted coverage is available; reserve the full suite for final root verification via validate_feature. Inspect output for actual coverage. The only supported verification format.  Required on the first attempt; continuations may omit it to inherit the retained verification plan. Revise commands through structured repairs; preserve required coverage and validators.",
      })),
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
          "(forwards to review-cli --wall-clock-budget-secs). Defaults to 180 seconds.",
      })),
      reviewMaxTurns: Type.Optional(Type.Integer({
        description:
          "Optional maximum model turns for review " +
          "(forwards to review-cli --max-turns). Defaults to 20 turns.",
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
      const result = await executeAndCheckpoint(params, {
        directory: ctx.cwd,
        abort: signal,
      }, { issueWorkflowOnly: true });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(executionSummary(result), null, 2) }],
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

// What each failure code means, who has to act, and what to do next. This is the one place that maps a
// code to a remedy; skills and tool results should not restate it. `owner` is who must act:
//   agent  the agent can fix this and retry
//   user   a person has to decide, approve or repair something outside the agent's reach
//   bug    the pipeline itself failed unexpectedly; stop and report it
// `info: true` marks a BLOCKED status that is a deliberate parked state, not a failure.
const A = "agent", U = "user", B = "bug";

export const FAILURE_CODES = {
  // Verification and review (execute_and_review)
  INCOMPLETE_VERIFICATION: { owner: A, next: ["Rerun the unchanged checks and review; PASSED needs successful execution, every requested check and an APPROVED independent review."] },
  REVIEW_SNAPSHOT_CHANGED: { owner: A, next: ["Source or index changed during the independent review. Do not edit files while it runs; continue with previousAttempt to rerun it."] },
  DIAGNOSIS_REQUIRED: { owner: A, next: ["The same failure keeps recurring. Record a concrete diagnosis with contextUpdates (kind: diagnose) and change the correction or plan before continuing."] },
  INFRASTRUCTURE_PAUSED: { owner: U, next: ["The review service or its configuration is failing. Preserve source and receipts; repair the service or credentials, then continue with one bounded attempt."] },
  RESOURCE_PAUSED: { owner: U, next: ["A time, output or context allowance was exhausted. Source was preserved; raise the relevant limit (for example reviewContextMaxBytes) and continue with previousAttempt."] },
  EXECUTABLE_NOT_FOUND: { owner: A, next: ["A required program is missing. Install or fix it, then continue with previousAttempt and empty operations; do not reapply source changes."] },
  EXECUTION_ERROR: { owner: A, next: ["The command run failed before producing a result. Read cause and the retained logs, fix the cause, then continue with previousAttempt."] },
  CHECK_MODIFIED_SOURCE: { owner: A, next: ["A verification check changed the source, so Review cannot accept its evidence. Swap its command for a read-only form (formatters: --check, no auto-fix flags) with contextUpdates kind repair_check, and continue with previousAttempt. Its changes are already in the working tree."] },
  STAGE_RECEIPT_MISSING: { owner: A, next: ["A stage stopped before retaining its receipt; message carries the stage's own error. If it says the source changed, do not edit files while a run is in flight and continue with previousAttempt; if it points at Pi or Conductor internals, report it."] },
  PROTOCOL_MISMATCH: { owner: B, next: ["Conductor or Review returned something Pi could not decode. Do not retry blindly; report this with the retained request and response."] },
  CANCELLED: { owner: U, next: ["The run was cancelled. Source and receipts are preserved; continue with previousAttempt when ready."] },
  WORKFLOW_TIMEOUT: { owner: U, next: ["The workflow ran out of time. Source and receipts are preserved; raise the time limit or narrow the checks, then continue with previousAttempt."] },
  OUTPUT_LIMIT: { owner: A, next: ["A command produced more output than allowed. Reduce its output, then continue with previousAttempt."] },
  INTERRUPTED_OR_RUNNING: { owner: A, next: ["An earlier attempt did not finish or is still running. Do not start another: inspect_issue_attempt for the latest receipt and continue from it."] },
  TERMINAL_RECEIPT_PENDING: { owner: B, next: ["Another process holds the terminal receipt. Retry once; if it persists, report it."] },
  EVIDENCE_RETENTION_FAILED: { owner: B, next: ["The result could not be stored in the ledger. Check that Scaffold is installed and the ledger is writable; do not reapply operations."] },
  REVIEW_FAILED: { owner: A, next: ["The independent review did not produce a result. Retry once; if it fails again, check the review service and credentials (INFRASTRUCTURE_PAUSED guidance applies)."] },
  TIMEOUT: { owner: U, next: ["A subprocess exceeded its deadline. Source was preserved; raise the time budget or narrow the work, then retry."] },
  CLEANUP_FAILED: { owner: A, next: ["Temporary review files could not be removed. The review result is unaffected; clear them manually if they persist."] },
  // Requests and Scaffold responses
  INVALID_ARGUMENTS: { owner: A, next: ["The request was malformed. Read message for the field, correct the arguments and retry; nothing was changed."] },
  INVALID_RESPONSE: { owner: B, next: ["Scaffold returned a response Pi could not validate. Check that the installed Scaffold matches Pi (schema 3) and report this with message."] },
  SCAFFOLD_FAILED: { owner: A, next: ["Scaffold refused or failed the operation; message carries its reason. Correct the request or state and retry; inspect with summary first."] },
  TASK_CONTEXT_INVALID: { owner: A, next: ["The task binding or design context could not be validated. Check task.featureId, taskId and designRef against scaffold_tasks issue, then retry."] },
  GUARDED_TOOL_FAILED: { owner: A, next: ["A guarded tool failed while running. Read cause and the retained logs, fix it, then continue with previousAttempt."] },
  // Continuation inputs
  CONTINUATION_INPUT_CONFLICT: { owner: A, next: ["Pass exactly one continuation input: issueHandoffRef or previousAttempt."] },
  CONTINUATION_HANDOFF_INVALID: { owner: A, next: ["The handoff reference is invalid or unreadable. Use inspect_issue_handoff to find the right reference, or prepare_issue_handoff for a new one."] },
  CONTINUATION_HANDOFF_STALE: { owner: A, next: ["The graph, source or attempt chain changed since that handoff. Run prepare_issue_handoff again, or continue from the latest receipt with inspect_issue_attempt."] },
  CONTINUATION_CONTEXT_INVALID: { owner: A, next: ["The continuation could not be applied. Read message; inspect_issue_attempt returns the exact continuation to use."] },
  // Check selection
  BROAD_CHECK_UNJUSTIFIED: { owner: A, next: ["A task check would run the whole suite. Narrow it with a test name, file, package or filter, or record why with broadCheckJustifications [{check, reason}]. Nothing was applied."] },
  BROAD_CHECK_JUSTIFICATION_INVALID: { owner: A, next: ["broadCheckJustifications must be an array of {check, reason} entries naming checks in the plan. Correct it and retry."] },
  // Independent review engine (reported in conductor.review.reason)
  AUTHENTICATION_FAILURE: { owner: U, next: ["The review service rejected its credentials. Repair the credential or configuration, then continue with one bounded attempt."] },
  NETWORK_FAILURE: { owner: U, next: ["The review service could not be reached. Wait or repair the connection, then continue with one bounded attempt after the cooldown."] },
  PROVIDER_FAILURE: { owner: U, next: ["The review provider failed. Wait or switch provider, then continue with one bounded attempt after the cooldown."] },
  RATE_LIMITED: { owner: U, next: ["The review service rate-limited the request. Wait for the cooldown, then continue with one bounded attempt."] },
  MODEL_FAILURE: { owner: U, next: ["The review model failed. Check the configured model, then continue with one bounded attempt."] },
  REVIEW_ENGINE_NOT_AVAILABLE: { owner: U, next: ["The review program is not available. Install or configure it, then continue with previousAttempt."] },
  BUDGET_EXHAUSTED: { owner: A, next: ["The review ran out of its turn, tool-call or time budget. Raise the review budget or narrow the scope, then continue with previousAttempt."] },
  LIMIT_EXCEEDED: { owner: A, next: ["The review exceeded a limit. Narrow the change or raise the limit, then continue with previousAttempt."] },
  SESSION_STALLED: { owner: A, next: ["The review session stalled. Continue with previousAttempt once; if it stalls again, report it."] },
  // Continuation and evidence
  EVIDENCE_RECOVERY_REQUIRED: { owner: A, next: ["The retained evidence does not match the current state. Use inspect_issue_attempt for the latest receipt; if commits exist that the ledger did not record, run inspect_feature_drift."] },
  CONTINUATION_RECEIPT_STALE: { owner: A, next: ["A newer attempt exists. Use inspect_issue_attempt and continue from its latest reference; consumed attempts are never reset."] },
  CONTINUATION_RECEIPT_MISSING: { owner: A, next: ["The named receipt is not in this feature's ledger. Use inspect_issue_attempt to find the right reference."] },
  CONTINUATION_RECEIPT_MALFORMED: { owner: A, next: ["previousAttempt must be a sha256:<64 hex> ledger reference copied from a result."] },
  CONTINUATION_RECEIPT_INAPPLICABLE: { owner: A, next: ["That receipt cannot be continued from (for example it already PASSED). Use inspect_issue_attempt."] },
  CONTINUATION_BASELINE_MISMATCH: { owner: A, next: ["The branch moved since that attempt. Omit baseRef to continue from the receipt's baseline; if commits were added to the branch, run inspect_feature_drift for the right recovery."] },
  CONTINUATION_TASK_MISMATCH: { owner: A, next: ["The receipt belongs to a different task. Pass the receipt of this task."] },
  // Preconditions
  ISSUE_REQUIRED: { owner: A, next: ["Pass the task binding (featureId, taskId, designRef) of the issue to implement."] },
  TASK_REQUIRED: { owner: A, next: ["A continuation needs the task binding. Pass task with featureId, taskId and designRef."] },
  HEAD_CHANGED: { owner: A, next: ["HEAD moved since the task started; nothing was applied. If someone committed to the branch, run inspect_feature_drift for the right recovery."] },
  CHECKPOINT_REQUIRED: { owner: A, next: ["The working tree has changes without a continuation receipt. If a prior attempt applied them, inspect_issue_attempt and pass its latest reference as previousAttempt; never discard source."] },
  SCAFFOLD_REVIEW_SCOPE: { owner: U, next: ["Scaffold state would appear in the review diff. Add .scaffold/ to the repository's ignore rules (ask the user first), then retry."] },
  REPOSITORY_CHANGED: { owner: A, next: ["The repository changed while the review ran. Rerun it on a stable tree."] },
  AUTOMATIC_CHECKPOINT_CONTEXT: { owner: A, next: ["The automatic checkpoint needs its context (featureBaseRef, branch, defaultBranch, protectedBranches). Supply it and retry."] },
  // Checkpointing
  CHECKPOINT_BLOCKED: { owner: A, next: ["Inspect Scaffold, the receipt, HEAD and the index. If the receipt PASSED, retry checkpoint_verified_task; never reset or replay blindly."] },
  FINALIZATION_BLOCKED: { owner: A, next: ["Keep the successful receipt and retry checkpoint_verified_task; never reapply operations to recover a failed commit."] },
  COMMIT_GATE_FAILED: { owner: A, next: ["The commit step did not produce a verified receipt. Retry checkpoint_verified_task with the successful implementation receipt."] },
  // Scaffold
  COMMAND_FAILED: { owner: A, next: ["Scaffold refused the operation; message names the rule. Read it, correct the request or state, and retry. Inspect with summary or list before retrying a write."] },
  UNKNOWN_FEATURE: { owner: U, next: ["No open feature has that id. Initialise it with /skill:init-feature, or check the feature id."] },
  INVALID_JSON: { owner: B, next: ["Scaffold returned output that is not JSON. Check the installed Scaffold version; report this."] },
  // Validation and generic
  VALIDATION_BLOCKED: { owner: A, next: ["Feature validation could not run or did not pass. Read message and cause; the recorded history and tasks are unchanged."] },
  INTERNAL_ERROR: { owner: B, next: ["The pipeline raised an unexpected error. Do not retry blindly; report this with cause."] },
  UNSPECIFIED_FAILURE: { owner: A, next: ["The tool returned a failure without a code. Read message; inspect state with summary before retrying."] },
  // Deliberate parked states, not failures
  ISSUE_SUSPENDED: { owner: A, info: true, next: [] },
  ISSUE_RECOVERY_READY: { owner: A, info: true, next: [] },
};

export const describeCode = (code) => FAILURE_CODES[code] ?? FAILURE_CODES.UNSPECIFIED_FAILURE;

// Strings in the source that look like codes but are not: review/attempt statuses, Git state files,
// stage labels and environment keys. A test requires every other UPPER_SNAKE literal to be in the table.
export const NOT_FAILURE_CODES = new Set([
  "NEEDS_DESIGN", "CHANGES_REQUESTED", "REVIEW_COMPLETED",
  "REVERT_HEAD", "MERGE_HEAD", "CHERRY_PICK_HEAD", "BISECT_LOG",
  "PRECHECK_OR_EVIDENCE", "PRECHECK_OR_CONDUCTOR",
  "CONDUCTOR_COMMAND_STDOUT_PATH", "CONDUCTOR_COMMAND_STDERR_PATH",
]);

// What to do when a tool asks for a correction (NEEDS_DESIGN). Only execute_and_review continues an
// attempt with previousAttempt; the other tools have no such input, so each gets its own guidance.
export const NEEDS_DESIGN_GUIDANCE = {
  execute_and_review: { owner: A, next: ["Fix what the failed check or review findings describe, then continue with previousAttempt; consumed attempts are never reset."] },
  validate_feature: { owner: A, next: ["Resolve each finding through a corrective issue (design it, implement it, checkpoint it) without discarding history, then rerun validate_feature."] },
  rewrite_feature_history: { owner: U, next: ["The rebased branch fails its checks or review, and nothing was recorded. The rebase is the user's to fix; report the findings, then rerun rewrite_feature_history once the branch is corrected."] },
  default: { owner: A, next: ["Read the findings in message and cause, correct what they describe, then rerun this tool."] },
};

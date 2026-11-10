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

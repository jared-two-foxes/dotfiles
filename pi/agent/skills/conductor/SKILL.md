---
name: conductor
description: >
  Native bounded implementation, checks and independent review under the retained
  overall feature direction approval. Pi designs and authors every correction.
---

# Conductor execution

Load /skill:design for the complete workflow. Obtain one approve_feature_direction
confirmation of the overall direction; it covers local design, implementation,
checks, independent review, verified checkpoints and recovery across sessions.
Do not ask again for individual designs, execution, commits or validation. Stop for
material changes outside that scope. Final feature checks and review remain mandatory.

Before execute_and_review, inspect current source, select one issue, persist its
agent-designed contract and prepare complete executor JSON using /skill:executor.
The removed `patch` variants are unsupported. Pass exact input, task identity,
fixed requirements and baseRef plus an explicit `checks` array. Prefer targeted
regressions for leaves and scoped integration tests for intermediate parents;
exclude the full repository/workspace test command whenever the runner supports
meaningful selection. Retain exact commands and coverage in the issue design.
Explain any unavoidable broader command. Reserve the full suite for final root
verification through validate_feature after checkpoints; corrective issues use
targeted checks before rerunning that final gate. Keep ordered checks fixed across
corrections. The buildCommand/testCommand pair remains an alternative input shape,
not a requirement to run the entire suite for each issue.
The native adapter constructs Conductor v2's ordered command list: `executor apply`
with the exact operations file, your selected checks, then `review-cli run --request`
with the fixed baseline and complete requirements file. Supply operations, checks
and review settings to execute_and_review; do not construct shell strings or call
those binaries yourself. All three binaries must be installed separately. Review
model and budget overrides become CLI flags; defaults are 180 seconds and 20 turns.
The final task check captures the source/index boundary before independent review.
Supply `checkpoint: {defaultBranch, protectedBranches}` using the known repository
default branch and all additional protected branches (or []). After a completed
APPROVED review, the native adapter retains successful evidence and automatically
runs a final Conductor Git commit command. It records Scaffold completion and
commits only the exact reviewed tree, using the existing verified checkpoint logic.

Conductor's generic FAILED is interpreted by the adapter. A failed application or
check and a completed CHANGES_REQUESTED review mean NEEDS_DESIGN; unavailable,
malformed, mismatched or INDETERMINATE review output means BLOCKED. A zero runner
exit alone is insufficient. Complete stdout/stderr paths are retained outside the
source tree; inspect full files or inspect_conductor_evidence when previews are
truncated, especially for structured Review JSON. Do not parse truncated JSON or
interpret an absent review as approval.

Use meaningful tests and inspect actual output. Offer full operations on request,
not by default. Never invoke Conductor/executor/review-cli from Bash or make source edits.

One call performs one attempt. Pi interprets NEEDS_DESIGN, authors corrections
against the current tree and supplies previousAttempt. Preserve five total attempts,
criteria/findings, baseline and checks within an epoch. BLOCKED stops automatic work.
Maximum budgets and provider errors are never review approval. Inspect real receipts;
PASSED requires successful execution, checks and APPROVED independent review.

On `stage: COMMITTED`, completion and the local checkpoint are already recorded.
Automatic finalization follows the receipt ending the active verification/correction loop.
Use `nextBaseRef` for the next issue; do not repeat completion or commit commands.
If `implementationStatus: PASSED` but finalization is BLOCKED, preserve its evidence
and call checkpoint_verified_task with that receipt and matching feature/branch
metadata. This resumes completion/commit only; never reapply operations or rerun
review to recover a failed commit. Each parent needs its own original-criteria verification
and commit after children, even if its commit is empty. Finish with validate_feature
against the original baseline. Inspect actual meaningful checks and final review;
add in-scope corrective issues and revalidate without additional permission prompts.

For missing prerequisites use suspend_issue, design/checkpoint new issues and
resume_issue with its authenticated handoff. Three attempts mean attempt four next.
Conflicts block with saved work intact. Rebase recovery uses its separate native
verification and handoff tools. The retained direction covers these actions without
new confirmations; it does not authorize doing a rebase or arbitrary history changes.

See extensions/conductor/README.md for complete protocol/verification contracts.
Git/GitHub publishing follows SYSTEM.md and requires a user request. Never merge PRs.

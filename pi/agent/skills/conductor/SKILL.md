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
Use meaningful tests and inspect actual output. Offer full operations on request,
not by default. Never invoke Conductor/executor/review-cli from Bash or make source edits.

One call performs one attempt. Pi interprets NEEDS_DESIGN, authors corrections
against the current tree and supplies previousAttempt. Preserve five total attempts,
criteria/findings, baseline and checks within an epoch. BLOCKED stops automatic work.
Maximum budgets and provider errors are never review approval. Inspect real receipts;
PASSED requires successful execution, checks and APPROVED independent review.

Complete the exact Scaffold issue from authentic evidence, end the active verification/correction loop,
then checkpoint_verified_task. Each parent needs its own original-criteria verification
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

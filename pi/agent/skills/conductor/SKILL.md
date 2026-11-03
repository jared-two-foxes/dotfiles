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
initial additional requirements and baseRef. Supply an explicit `checks` array
on the first attempt. Continuations may omit `checks` to inherit the retained
verification plan. Prefer targeted regressions for leaves and scoped integration
tests for intermediate parents; exclude the full repository/workspace test
command whenever the runner supports meaningful selection. Retain exact commands
and coverage in the issue design. Explain any unavoidable broader command.
Reserve the full suite for final root verification through validate_feature
after checkpoints; corrective issues use targeted checks before rerunning that
final gate. Keep ordered checks fixed across corrections except for explicit
command invocation repairs described below. On a first attempt, `requirements`
contains additional scope (or an empty string); the adapter adds persisted
criteria, constraints and the complete approved issue design. Do not transcribe
that design. For corrections, supply fresh operations and either an applicable
`issueHandoffRef` or the exact `previousAttempt` receipt. Native tools assemble
inherited context. Use structured contextUpdates for discoveries
and repairs. Branch and design-reference mismatches require correcting the
context, not reapproval. Named checks may include
`successCondition: [program, ...args]` for a known tool-specific output
contract. Conductor passes the original exit code and complete stdout/stderr
paths through `CONDUCTOR_COMMAND_*`environment variables.
Use the default exit-code rule for ordinary Cargo compile/test commands.
The native adapter constructs Conductor v2's ordered command list:`executor apply`with the exact operations file, your selected checks, then`review-cli run --request`with the fixed baseline and complete requirements file. Supply operations, checks
and review settings to execute_and_review; do not construct shell strings or call
those binaries yourself. All three binaries must be installed separately. Review
model and budget overrides become CLI flags; defaults are 180 seconds and 20 turns.
The final task check captures the source/index boundary before independent review.
Review has a built-in structured condition requiring complete APPROVED output;
its verdict is checked before the in-list commit can run.
Supply`checkpoint: {defaultBranch, protectedBranches}` using the known repository
default branch and all additional protected branches (or []). After a completed
APPROVED review, the final command in the SAME Conductor list seals verification
evidence and creates the Git checkpoint. Normal delivery uses one runner call;
there is no second automatic commit request. Stage wrappers retain actual process
exit results so the final command can authenticate review before the runner returns.
It records Scaffold completion and
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
against the current tree and supplies the continuation reference. There is no per-issue attempt limit; preserve
criteria/findings, baseline and invocation history. BLOCKED stops the current command
list, not Pi's diagnosis or an authorized, evidence-bound correction.
Maximum budgets and provider errors are never review approval. Inspect real receipts;
PASSED requires successful execution, checks and APPROVED independent review.

### Recover a failed or blocked attempt

Inspect the returned receipt with `inspect_issue_attempt`; use its minimal `continuation`
receipt reference and supply new operations against the current source. The prior
attempt's `after` snapshot includes successfully applied edits even when checks
or Review failed. Keep `baseRef` at the original HEAD: the review covers the entire
cumulative diff. Do not reset files, delete receipts, reinitialize Scaffold, or
checkpoint unverified work. Do not replay already-applied operations or add identity
edits for unchanged files. Use `{"operations":[]}` for a checks-only retry.

If a check's command is wrong (for example `sh` is absent on native Windows), keep
the named checks in order and supply `verificationRepairReason` explaining the
failure, repaired invocation and equivalent coverage. This permits command changes,
not removing/renaming/reordering checks or changing success conditions. Keep the
original criteria and constraints retained. The repair reason and plan reach independent
Review and are retained in the authenticated attempt chain. Never change a command
to hide a failing test. A changed verification contract requires explicit Design
recovery. Prefer direct executable/argv commands; when shell syntax is essential,
inspect the host first and use its available shell (`cmd /c` or PowerShell on native
Windows, `sh -c` only where installed). Preserve environment assignment/quoting semantics.

If Scaffold is blocked/failed, inspect its state, `retry` with the recovery reason,
then `start` the same issue. Those transitions do not reset receipts or consumed
attempts. A fresh context may discover the latest receipt through
`prepare_issue_handoff`. Inspect the receipt details with `inspect_issue_attempt`
when diagnosing a correction. Pass the applicable saved context reference as
`issueHandoffRef` to continue without copying the receipt hash. For stale context
or receipt prechecks, use the returned `prepare_issue_handoff` recovery action
and inspect the latest attempt before retrying. After `resume_issue` and the
required `start`, pass its execution receipt `handoffRef` as `previousAttempt`.

Continue a diagnosed, in-scope correction under the existing direction approval.
Stop for unavailable prerequisites/credentials, unresolved source/index drift,
resource pauses, infrastructure circuits or evidence-backed DIAGNOSIS_REQUIRED;
report the concrete blocker with retained evidence. Do not blindly retry unchanged
commands. On a source/tree mismatch, preserve all work and use the appropriate
recovery path; never force acceptance of an unrelated tree.

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

### Structured context and resumption

`contextUpdates` accepts add_obligation, annotate, correct_assumption, revise_design,
propose_addressed, repair_check, add_check and diagnose. Supply a reason per update.
Original criteria remain immutable in the review context; material scope changes
and obligation removal go through Design approval. Findings have stable IDs;
propose_addressed is an author claim, never independent verification. Review must
explicitly assess every open obligation before checkpointing.

Three equivalent substantive outcomes or source-state cycles trigger diagnosis.
Compile → test → new review findings may demonstrate progress; changed wording,
check labels or unrelated edits do not. Review infrastructure opens a circuit.
Measured executable/credential-file repair permits continuation; transient network
or provider failures permit one caller-driven probe after five minutes. There is
no sleep loop or scheduler. A depleted invocation allowance pauses until a revised
budget is supplied and records previous usage.

Empty operations support verification-only continuation. Optional
checkEnvironmentInputs declares non-secret files, variables and executables for
pure deterministic checks. Reuse requires exact source/index/HEAD, unchanged
commands/validators and matching measured environment. Unknown ambient state means
rerun checks. Reused receipts remain explicitly linked and authenticated. Recognized
Cargo, pytest, Vitest, Jest and Mocha test runs receive a meaningful-count validator
when no explicit semantic validator was supplied. Never weaken a validator to pass.

An existing v1 chain migrates on its original identity, baseline and receipt links,
including a latest fifth attempt. Scaffold's journal and Git audit anchor prevent
missing evidence from looking like a new run. A missing or contradictory anchor,
in-flight intent or receipt requires explicit recovery; no reset or reapproval.
See extensions/conductor/RECOVERY.md for runtime details and current limitations.

Material contract amendments use approve_delivery_amendment with the latest receipt,
concrete original criterion/finding IDs, replacement and reason. Only that exceptional
delta requests user confirmation. Apply its returned reference through
contextUpdates.apply_amendment; originals and invocation history remain retained,
and replacement behavior requires independent verification. For environment-only
credential rotation use reviewProbe with empty operations; failed probes are bounded
and throttled. Oversized review context can resume with an explicit
reviewContextMaxBytes allowance increase without dropping obligations.

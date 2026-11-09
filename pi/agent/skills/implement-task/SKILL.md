---
name: implement-task
description: >
  Implement one existing Scaffold issue through bounded Executor/Conductor attempts,
  targeted checks, independent review, correction and verified checkpoint.
---

# Implement one task

This is the task-scoped implementation and recovery workflow. Accept an existing
Scaffold `featureId` and `taskId` with persisted design, criteria and authorized
feature direction. The feature-level orchestrator (`/skill:feature-delivery`)
selects eligible issues, orders dependencies and owns the overall approval, graph
decomposition and final feature validation. This skill does not create a feature,
approve direction, choose the next task or run the feature-wide final gate.

A direct invocation is valid for one already selected, approved, eligible issue.
Fetch scoped issue state and retain exact task identity, baseline, branch and
previous evidence. Where permission or an approved design is missing, return a
clear blocker and direct the caller to `/skill:init-feature` for preparation; do not infer approval from a chat summary.
Use `/skill:design` only for engineering design, not execution authority.
The retained overall feature direction covers in-scope task implementation,
checks, independent review, verified checkpoints and recovery across sessions.
Do not request a second per-task confirmation. Stop and return control for
material direction changes or missing prerequisites outside the task contract.

**Completion means a verified, independently reviewed and checkpointed task**
(`stage: COMMITTED`), not merely a successful Conductor invocation. On
NEEDS_DESIGN or BLOCKED, diagnose evidence and either perform an allowed
in-scope correction or return the authenticated blocking state to the feature
orchestrator. Never silently expand the Scaffold graph.

Before execute_and_review, inspect current source and the caller-selected issue's
persisted design and prepare complete executor JSON using /skill:executor.
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
contract. Omit it for ordinary Cargo compile/test commands so the adapter can
apply its defaults. See /skill:conductor for the runner's evaluator protocol.

Supply operations, checks and review settings to `execute_and_review`. The
adapter prepares the exact Executor and Review inputs and submits the ordered
workflow to Conductor. Use the native delivery tool for this workflow. Review
model and budget overrides become CLI flags; defaults are 180 seconds and 20 turns.
The final task check captures the source/index boundary before independent review.
Review has a built-in structured condition requiring complete APPROVED output;
its verdict is checked before the in-list commit can run.
Supply `checkpoint: {defaultBranch, protectedBranches}` using the known repository
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

### Recover a failed or blocked attempt

One call performs one attempt. If the attempt returns `NEEDS_DESIGN` or
`BLOCKED`, inspect the retained evidence and read
[Retry policy](references/retry-policy.md) before deciding whether to continue.
For an allowed correction, prepare new operations against the current tree and
call `execute_and_review` with the continuation reference.

Inspect the returned receipt with `inspect_issue_attempt`; use its minimal `continuation`
receipt reference and supply new operations against the current source. The prior
attempt's `after` snapshot includes successfully applied edits even when checks
or Review failed. Keep `baseRef` at the original HEAD: the review covers the entire
cumulative diff. Do not reset files, delete receipts, reinitialize Scaffold, or
checkpoint unverified work. Do not replay already-applied operations or add identity
edits for unchanged files. Use `{"operations":[]}` for a checks-only retry.

If a check's command is wrong (for example `sh` is absent on native Windows), keep
the named checks in order and supply `contextUpdates` with `kind: "repair_check"`,
the original `checkId`, repaired `command` argv and `reason` explaining the failure
and equivalent coverage. This permits command changes,
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

For missing prerequisites or oversized scope, retain the latest receipt and
return NEEDS_DECOMPOSITION/NEEDS_DESIGN with a proposed prerequisite and
reconciliation reference to feature-delivery. That orchestrator owns suspend_issue,
graph redesign, dependency implementation and resume_issue. Do not create
new Scaffold issues or silently change the approved task boundary.
Conflicts block with saved work intact. Rebase recovery uses its separate native
verification and handoff tools. The retained direction covers these actions without
new confirmations; it does not authorize doing a rebase or arbitrary history changes.

See extensions/execute-and-review/README.md for complete protocol/verification contracts.
Git/GitHub publishing follows SYSTEM.md and requires a user request. Never merge PRs.

### Structured context and resumption

`contextUpdates` accepts add_obligation, annotate, correct_assumption, revise_design,
propose_addressed, repair_check, add_check and diagnose. Supply a reason per update.
After an approved redesign and authenticated issue resume, use
`repair_check` with `checkId`, `useMeaningfulTestEvaluator: true` and `reason`
to replace a malformed evaluator for a recognized test runner. Inherit the exact
commands and check order. Conductor runs the repaired check before review.
Original criteria remain immutable in the review context; material scope changes
and obligation removal go through Design approval. Findings have stable IDs;
propose_addressed is an author claim, never independent verification. Review must
explicitly assess every open obligation before checkpointing.

Empty operations support verification-only continuation. Optional
checkEnvironmentInputs declares non-secret files, variables and executables for
pure deterministic checks. Reuse requires exact source/index/HEAD, unchanged
commands/validators and matching measured environment. Unknown ambient state means
rerun checks. Reused receipts remain explicitly linked and authenticated. Recognized
Cargo, pytest, Vitest, Jest and Mocha test runs receive a meaningful-count validator
when no explicit semantic validator was supplied. Never weaken a validator to pass.

Current versioned-context chains continue on their original identity, baseline and
receipt links. Obsolete fixed-context attempts are rejected without migration. Scaffold's journal and Git audit anchor prevent
missing evidence from looking like a new run. A missing or contradictory anchor,
in-flight intent or receipt requires explicit recovery; no reset or reapproval.
See extensions/execute-and-review/RECOVERY.md for runtime details and current limitations.

Material contract amendments use approve_delivery_amendment with the latest receipt,
concrete original criterion/finding IDs, replacement and reason. Only that exceptional
delta requests user confirmation. Apply its returned reference through
contextUpdates.apply_amendment; originals and invocation history remain retained,
and replacement behavior requires independent verification.


## Task-scoped operational guidance migrated from feature delivery

### Prepare executor handoff

Before generating Executor input, inspect exact current source and load
`/skill:executor`. Prepare and retain the complete executor input. Use `edit_file` for in-place text changes as documented there; never send unified diffs as operations.
Generate only the selected issue's complete operations, not a feature-wide operation
set split afterwards. Pass exact JSON and meaningful verification commands as
executable/argument arrays to `execute_and_review`, plus
`checkpoint: {defaultBranch, protectedBranches}` with known repository branch
protection metadata. A successful review automatically records completion and
creates a local commit of the exact reviewed tree. Retained feature direction
approval already covers this action; do not ask again.

### Select checks for the current issue

Prefer an explicit `checks` array with the smallest meaningful verification plan
for this issue. During its design pass, identify the affected behavior, relevant
tests, exact executable/argument arrays and expected coverage; retain that plan in
its design verification record. Inspect the repository's test runner and existing
scripts rather than guessing filters. Use test-name, file, package, module or target
filters as supported. For example, a Rust crate change may use
`["cargo", "test", "-p", "affected-crate", "regression_name"]`; a Node test change
may use `["node", "--test", "tests/affected.test.mjs"]`. Include a scoped build,
type check or lint check when it establishes relevant correctness.
If a tool's exit code does not establish success, set that named check's optional
`successCondition` to an explicit executable/argv array that examines the full
output path or other state. Its exit 0 advances Conductor. Do not add generic
text matching to Cargo build/test when their exit status already expresses
failure; use a tool-specific condition for cases such as a zero-test run.

Leaf issues run targeted regressions; intermediate parents run scoped integration
checks for their immediate children and interfaces. Exclude the full repository or
workspace test command from these nodes' `checks` whenever targeted coverage is
available. Do not append an unfiltered full-suite command as a default safety check.
If the runner cannot select the necessary tests, explain and retain why the broader
command is needed; never substitute an irrelevant passing check or omit required
coverage merely to keep commands narrow. Inspect output to prove the selected tests
actually ran, including correct handling of filters matching no tests.

A first attempt that includes a bare full-suite command (a plain `cargo test`,
`npm test`, `pytest`, `go test ./...`, `dotnet test`, `node --test`, `vitest`,
`jest` or `mocha`) is rejected with `BROAD_CHECK_UNJUSTIFIED` before any source
operation. Narrow it with a test name, file, package or filter. If the runner truly
cannot select the needed tests, name the check in `broadCheckJustifications:
[{check, reason}]` and record the same reason in the issue's design verification
record. Continuations inherit the retained plan and are not re-checked.

Reserve the full test suite for the final root/feature verification through
`validate_feature` after required issue checkpoints. The root's implementation
attempt may use focused integration checks; the final gate supplies full-project
build/test commands and independently reviews the complete result. Avoid duplicating
that expensive suite across each issue or parent. If final review creates corrective
issues, use targeted checks for those issues, then rerun the full final gate.

The selected ordered plan stays fixed within a correction epoch. For an invocation
error, use a structured `repair_check` update with equivalent commands, preserving names,
order, success conditions and coverage. Never silently weaken a plan; changed
verification contracts require Design recovery retaining criteria, history and count.

### Task attempt and correction loop

Capture the current checkpoint HEAD once as the issue's baseRef and retain that
baseline within its correction epoch. The adapter versions and assembles context. Preserve the check contract; explicit
invocation repairs follow /skill:implement-task. Start the explicit
Scaffold issue before execution. Supply task identity and the previousAttempt for
corrections. Use `previousAttempt`, fresh `input` and structured `contextUpdates`; inspect
`inspect_issue_attempt` for the authoritative context; inspect full logs
through `inspect_conductor_evidence` only when needed. Do not hide Scaffold state in
the review diff: bookkeeping must be ignored and untracked.

- PASSED: inspect authentic execution, meaningful check output, APPROVED independent
  review and exact tree/task binding. Native `execute_and_review` automatically
  records Scaffold completion and runs the verified Git commit command. On
  `stage: COMMITTED`, use `nextBaseRef`; do not repeat completion or checkpointing.
  If implementation passed but commit finalization blocked, use
  `checkpoint_verified_task` with the same successful receipt and matching scope.
  Never reapply operations or rerun review to recover a failed commit. Each resolved node gets its own
  commit, including an empty commit for parent verification. A parent remains incomplete
  after children finish until its original integrated criteria pass independently.
- NEEDS_DESIGN: inspect actual source/diff and findings, author a minimal correction
  against the current tree with the latest `previousAttempt`, or use the discovery
  exit hatch for additional issues. Never replay the original operations.
- BLOCKED: stop the current command list, retain evidence and partial work, inspect
  the actual cause and continue an in-scope recoverable correction under the existing
  approval. Follow /skill:implement-task's recovery procedure. An environment failure is
  not a code defect. Keep the prior after-tree; a checks-only retry uses an empty
  operations array. Stop only for a concrete unresolved blocker or loop limit.
- Oversized task: suspend and decompose only the remaining unverified responsibilities.

There is **no per-issue attempt limit**. Preserve every invocation across contexts
and handoffs. Native stall detection pauses after three equivalent substantive
outcomes or recurring source cycles. Infrastructure circuits and resource pauses
are separate. Diagnose the returned signature and change the relevant correction
or plan; never create replacement issues or remove history to continue.
Scaffold state transitions do not prove verification. If authentic completion or a
checkpoint is unavailable, report checkpoint required and stop dependent execution.

### Checkpoint recovery

Read scoped Scaffold `summary`/`issue`, relevant receipts, Git HEAD/history/index/worktree and
`Pi-Task-Checkpoint` commit trailer before selecting work. Completion without a
checkpoint: use the retained feature authority and call the tool with the original receipt.
A retry before commit stages only the exact retained Git tree in a private index;
the real index is never used as a catch-all. Interruption after commit: the tool
recognizes matching provenance, exact parent and tree at HEAD, then repairs an index equal to the old baseline only when the atomic Git
`refs/pi-checkpoints/<receipt-hash>` pending marker proves an unfinished index
update. Without that marker, only an index equal to the verified tree is accepted.
The marker is removed after index finalization; a staged reversal after a finished
checkpoint is preserved and rejected. It returns the existing SHA
with `recovered: true`; it does not create a duplicate. Repeated successful calls
also return that SHA. A new session reuses the matching retained feature authorization.

A hard process kill may leave Git's standard `index.lock`. The tool never removes
an existing lock. Establish that no Git process owns it; have the user explicitly
resolve the stale lock, then retry. Do not reset/discard source or index changes.
Unexpected HEAD, unrelated edits, divergent staged versions, ambiguous state,
missing evidence or a mismatch blocks recovery. Reconcile explicitly. A matching
checkpoint can explain why the old receipt no longer matches an uncommitted tree;
do not rerun implementation merely because that fingerprint changed on commit.
If later task commits already exist, inspect their parent/provenance chain; do
not replay an older checkpoint request (the tool only reconciles current HEAD).

Receipt Git trees are local objects retained with the existing evidence records;
commits carry their provenance without another workflow database. Keep receipts
with this checkout. Hashes detect corruption, not malicious local rewriting.
For task calls, the adapter transparently wraps the approved test executable and
arguments, preserving its output and exit code. A successful test captures the
full Git tree/fingerprint immediately before Conductor starts independent review.
A missing boundary or any final source/index mismatch blocks PASSED and checkpoints.
The receipt retains both boundary and final snapshots, plus the actual request.
This is a narrow Pi adapter addition; Conductor still performs one attempt and
never commits. Checkpoint scope comes from actual Git state and the full review
baseline, not Executor paths. Concurrent external writers remain unsupported:
endpoint fingerprints cannot detect transient changes restored during review.
Stop if concurrent activity is suspected; local hashes are not adversarial proof.


### Versioned continuation

A correction supplies `previousAttempt`, fresh exact `input` and optional structured
`contextUpdates`. Native tools inherit task identity, baseline, approval, checks and
all original obligations. Do not copy approval prose, hashes or requirements text.
Use add_obligation for discoveries, annotate/correct_assumption/revise_design for
in-scope evolution, repair_check for equivalent invocation repairs and add_check
for additional coverage. Every update needs a reason. Removing obligations or
material scope changes requires the explicit Design/approval transition.

A proposed_addressed claim never closes a finding. Independent Review must return
an explicit verified assessment for each open stable obligation ID. Final feature
review carries original criteria, issue contexts and unresolved feature findings.

Use checkEnvironmentInputs only when all relevant inputs of deterministic checks
can be measured; otherwise omit it and rerun checks. No secrets belong in this
manifest. A reviewer-only repair can reuse matching source/index/HEAD, definitions,
environment and authenticated successful check evidence. Reused stages are linked
to their original receipts; they are not described as freshly executed checks.

INFRASTRUCTURE_PAUSED requires relevant repair or the permitted bounded probe after
cooldown. RESOURCE_PAUSED retains usage and needs an explicit allowance revision.
DIAGNOSIS_REQUIRED includes evidence-backed signatures; unsupported claims of
progress do not reset it. EVIDENCE_RECOVERY_REQUIRED means restore authoritative
proof or report the exact blocker. Preserve files, index, original baseline, Git
audit anchors and all receipts. Never reapprove unchanged direction to recover.

Material contract amendments use approve_delivery_amendment with the latest receipt,
concrete original criterion/finding IDs, replacement and reason. Only that exceptional
delta requests user confirmation. Apply its returned reference through
contextUpdates.apply_amendment; originals and invocation history remain retained,
and replacement behavior requires independent verification. For environment-only
credential rotation use reviewProbe with empty operations; failed probes are bounded
and throttled. Oversized review context can resume with an explicit
reviewContextMaxBytes allowance increase without dropping obligations.

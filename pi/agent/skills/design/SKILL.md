---
name: design
description: >
  Design and deliver a recursive issue graph under one approved overall feature
  direction. Pi owns bounded design, executor authoring and review corrections;
  Conductor verifies each attempt and the complete feature receives final review.
---

# Design and delivery

Research → Design → Implement. Use one overall feature direction approval for the
local delivery loop. Do not ask for per-issue design approval, a second design
confirmation, execution permission, checkpoint confirmation or verification permission.
The retained direction authorizes scoped work across sessions. A context handoff
is navigation evidence; it cannot grant authority by itself.

Never directly modify the repository for implementation. Only native
`execute_and_review` applies exact Executor operations and runs checks/review.
Native checkpoints, verification and recovery retain their own deterministic
preconditions and use the same retained feature authorization. Do not substitute
Bash source edits, executor/review-cli calls, stash/reset or history rewrites.
For Git/GitHub publishing follow SYSTEM.md: publication needs a user request;
Never merge PRs. Finish or suspend the active verification/correction loop before
publishing. Offer full operations on request, not by default.

## 1. Discovery and overall direction

Inspect the actual repository, existing source, relevant tests, interfaces, Git
branch/status and local instructions. Establish the ticket objective, acceptance
criteria, boundaries, important interfaces, constraints and proposed approach.
Discuss unresolved choices that affect the user's objectives, public behaviour,
compatibility, cost or scope. Do not design every private detail up front.

### Feature planning and the single approval

Present a concise overall design direction and the intended local delivery scope:
design/decomposition, implementation, relevant checks and independent review,
verified local commits, final feature validation, and necessary issue/rebase recovery.
Persist its exact text in feature context using `scaffold_tasks` `init`, immutable
`design_ref: "sha256:context"`, original full Git baseline and feature branch.
Scaffold creates the root issue. State creation does not grant source authority.

Call native `approve_feature_direction` with featureId. Its UI confirmation is the
single approval: present the direction, then invoke this tool without a separate
conversational yes/no question. On refusal or absent UI, stop before implementation.
The tool retains scope-bound authority; existing matching approval is reused without
prompting, including after a new session. Preserve its returned reference.
Do not invent authority from a design note, transcript summary or issue status.

An existing feature may use this tool to approve its retained overall direction
once. Prior per-issue approvals alone do not imply this broader delivery grant.

## 2. Design the issue graph downward

Conversational memory is not authoritative; authenticate persisted state and evidence.
Use `summary`, then `design-select` (the compact equivalent of `design-next`) for
one eligible issue. Inspect only that issue's scoped context, ancestor contracts,
inherited dependencies and relevant source. Make detailed engineering decisions
within the approved direction yourself. Share concise progress when useful;
do not turn design previews into additional approval requests.

### One bounded design pass

Define inputs, outputs, immediate responsibilities, interfaces, invariants,
producers/consumers, ownership/lifecycle, failure behaviour and verification.
Use focused `diff` blocks with changed portions marked when explaining decisions;
these are illustrative design excerpts, not executor input. Keep the implementation
preview proportional to the issue and cover acceptance criteria and edge cases.

Mandatory decomposition applies when the issue cannot be understood, implemented
and independently verified in one bounded scope. Add immediate children with
`decompose`; defer their internal details to their own design passes. Preserve
ancestor dependencies and completed descendants. Every child needs a stable ID,
objective, criteria, context, constraints and explicit dependencies. Put
`Verification:` strategy and edge cases in context; retain review/discovery origin.
Definitions remain immutable. Small changes use the root itself as the leaf.

Persist each agent-authored design with `design-record`:
`{summary, verification, approval, disposition: "leaf"|"decomposed"}`.
The existing `approval` field records delegated authority, for example:
"Agent-designed under overall feature direction authorization <actual reference>;
no separate user approval was requested for this issue."
Never claim the user approved an individual issue if they did not. Add a parent's
immediate children before recording its design. Reopened designs retain their
history and invalidate affected unfinished designs, which Pi redesigns autonomously.

Continue downward until every issue has a complete design, then `design-finish`.
No implementation may run before this entire graph design phase completes.
Scaffold validates structure and association, not authority or verification truth.

## 3. Implement upward and process discoveries

Use `select` for one eligible issue. Recover its current design and inspect source.
Do not redo design approvals or request execution confirmation. Include the exact
stored design suffix, own acceptance criteria, inherited constraints and established
interfaces in fixed requirements; future feature criteria remain context.

```text


Approved issue design <designs[0].reference>
<designs[0].summary>
Verification: <designs[0].verification>
Approval record: <designs[0].approval>
```

### Discovery exit hatch

Straightforward corrections remain attempts on the same issue. Missing prerequisites,
oversized remaining work and review findings within the approved direction return
the affected scope to Design without asking again. Stop the active loop and use
`suspend_issue` with the latest receipt, original baseline, branch/protection scope,
reason and reconciliation reference. It preserves tracked/staged/untracked source,
receipts, findings and attempts before parking work. Without any attempt, clean
zero-attempt suspension is supported. Inspect DESIGN and suspensionRef.

Design/decompose the new issues, `design-finish`, implement/checkpoint prerequisites,
then `resume_issue`. Inspect READY, handoffRef, consumed count and returned resume
fields. READY is not PASSED. Start the same issue, author fresh input, and continue
using the handoff as previousAttempt. Three consumed attempts mean the next is four.
Never reset the issue, weaken criteria/findings or blindly replay old operations.
Conflicts, stale state or exhausted budgets block with saved work retained.
Without unfinished work use `design-reopen` directly. Completed nodes remain intact;
final review findings become dependent corrective issues in the same graph.

Stop and ask only when the work requires changing approved objectives, externally
visible behaviour, explicit constraints or other material commitments, or when a
necessary decision cannot be inferred. Explain the departure before seeking revised
overall direction approval. Ordinary algorithms, internal boundaries, test selection
and corrections that satisfy the approved direction are delegated decisions.
Original ticket criteria must block rather than weaken them when incompatible work
is discovered. Do not fabricate revised evidence or replace an active feature.

## 4. Prepare executor handoff

Before generating Executor input, inspect exact current source and load
`/skill:executor`. Prepare and retain the complete executor input. Use `edit_file` for in-place text changes as documented there; never send unified diffs as operations.
Generate only the selected issue's complete operations, not a feature-wide operation
set split afterwards. Pass exact JSON and meaningful verification commands as
executable/argument arrays to `execute_and_review`. Retained feature direction
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

Leaf issues run targeted regressions; intermediate parents run scoped integration
checks for their immediate children and interfaces. Exclude the full repository or
workspace test command from these nodes' `checks` whenever targeted coverage is
available. Do not append an unfiltered full-suite command as a default safety check.
If the runner cannot select the necessary tests, explain and retain why the broader
command is needed; never substitute an irrelevant passing check or omit required
coverage merely to keep commands narrow. Inspect output to prove the selected tests
actually ran, including correct handling of filters matching no tests.

Reserve the full test suite for the final root/feature verification through
`validate_feature` after required issue checkpoints. The root's implementation
attempt may use focused integration checks; the final gate supplies full-project
build/test commands and independently reviews the complete result. Avoid duplicating
that expensive suite across each issue or parent. If final review creates corrective
issues, use targeted checks for those issues, then rerun the full final gate.

The selected ordered plan stays fixed within a correction epoch. Do not silently
replace checks in an existing receipt chain to adopt this policy; reconcile a
required plan change explicitly while retaining criteria, history and attempt count.

## 5. Own the execution and review loop

Capture the current checkpoint HEAD once as the issue's baseRef and keep requirements,
ordered checks and baseline fixed within its correction epoch. Start the explicit
Scaffold issue before execution. Supply task identity and the previousAttempt for
corrections. Recover exact fields using `inspect_issue_attempt`; inspect full logs
through `inspect_conductor_evidence` only when needed. Do not hide Scaffold state in
the review diff: bookkeeping must be ignored and untracked.

- PASSED: inspect authentic execution, meaningful check output, APPROVED independent
  review and exact tree/task binding. Complete the Scaffold issue from that receipt,
  end the loop and use `checkpoint_verified_task`. Each resolved node gets its own
  commit, including an empty commit for parent verification. A parent remains incomplete
  after children finish until its original integrated criteria pass independently.
- NEEDS_DESIGN: inspect actual source/diff and findings, author a minimal correction
  against the current tree or use the discovery exit hatch for additional issues.
- BLOCKED: stop automatic attempts, retain evidence and partial work, record the
  real reason and reconcile explicitly. An environment failure is not a code defect.
- Oversized task: suspend and decompose only the remaining unverified responsibilities.

Maximum **five total application attempts** per issue, preserving consumed counts
across contexts and handoffs. Stop after two consecutive attempts with the same
substantive failure and no progress. Do not create replacement issues to reset limits.
Scaffold state transitions do not prove verification. If authentic completion or a
checkpoint is unavailable, report checkpoint required and stop dependent execution.

## Checkpoints, recovery and final review

The initial feature authority covers verified local checkpoints, bounded checks,
independent review and recovery on the approved feature branch. The native tools
reuse it across sessions without routine confirmation. Supply actual default and
known protected branches, original feature baseline and any reconciliationRef.
Protected branches, unrelated source and unverified commits remain prohibited.

#### Checkpoint recovery

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


## Final feature verification

After every leaf and parent is completed and checkpointed, run `validate_feature`
against the original baseline and original approved direction with meaningful full
project checks and bounded independent review. The feature authority covers this
verification without another confirmation. Review receives actual diagnostics,
original criteria and issue contracts. Zero exit status alone never establishes
coverage; require concrete successful test output. INDETERMINATE is BLOCKED.
Final feature review is mandatory even when all individual issues have passed.

Resolve in-scope findings through corrective issues, redesign/implement/checkpoint
without further approval prompts, then rerun the full gate. Preserve original
criteria and every historical failure. Stop on material scope changes as above.
Report actual tests, unresolved findings, feature review outcome and reviewable
commits/PR to the user. Do not declare completion from `select: null` alone.

For user-performed rebases use `reconcile_feature_rebase` between tasks or
`recover_interrupted_task_rebase` for an interrupted chain. Preserve original
receipts, baseline, criteria and budget. Inspect retained evidence using the matching
inspection tools; only an authenticated handoff changes the continuation baseline.
The retained feature authority covers verification/recovery, not performing a rebase
or arbitrary history rewriting. See extensions/conductor/README.md for exact inputs.

## Scoped context and persisted issue handoff

Use `scaffold_tasks` `summary` for phase, counts and state digest; `design-select`
for the next design issue; `select` for the next implementable issue; and `issue`
with explicit task_id to fetch one issue. Scoped context includes its approved
design, ancestor contracts, inherited prerequisite contracts and immediate children.
It omits lifecycle transcripts, sibling bodies and old executor inputs. Selection
is read-only and null never proves completion. The native Pi tool also projects
old next/design-next calls into scoped selection and returns compact mutation
acknowledgements. Full `list` remains an explicit diagnostic operation; native
verification continues to inspect complete state and receipts internally.

After selecting an issue, use native `prepare_issue_handoff` with featureId/taskId
and optional notes `{next_action, source_locations, open_questions}`. Save useful
navigation notes before ending the issue session. The returned reference identifies
an immutable context capsule bound to graph state, approved contracts, Git source,
index/HEAD and latest authenticated attempt. No implementation or graph transition
occurs. Notes are agent-authored reminders, never user approval or verification.

On a fresh context use `inspect_issue_handoff` with reference, or featureId/taskId
to discover the newest saved handoff. Inspect `applicable`; stale context is omitted
and a refresh instruction is returned. Prepare a fresh handoff after graph, source
or attempt changes. Refresh does not carry old notes automatically: inspect actual
state and reconcile open questions. `inspect_issue_attempt` retrieves exact retained
requirements/checks and consumed attempts without loading raw logs or executor
input. Retrieve full diagnostics through inspect_conductor_evidence only when needed.
Latest finding excerpts never establish that earlier findings were resolved.
These context tools grant no design/execution/checkpoint authority and never replace
receipt authentication, fixed requirements or the attempt budget.

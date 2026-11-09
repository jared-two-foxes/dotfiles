---
name: feature-delivery
description: >
  Orchestrate multi-task implementation of an initialized, approved Scaffold
  feature, using implement-task for issues and final feature validation.
---

# Autonomous feature delivery

## Cleaned or recreated feature state

`scaffold clean` is a human-only administrative action, not a recovery step,
Pi tool or implicit initialization fallback. If the current Scaffold feature
is missing after a reset or its `workflow.instance_id` differs from retained
handoff/receipt authority, stop delivery. Do not reuse old attempts or approvals.
Preserve Git commits, source changes and external evidence; ask for explicit
new feature preparation through `/skill:init-feature` and a fresh overall
direction approval before any new work on the recreated instance.



This skill orchestrates multi-task delivery of a prepared feature.
Use `/skill:init-feature` to create or finish the approved Scaffold graph and
`/skill:design` for a standalone engineering contract. Here Pi owns task
selection, prerequisite recovery, correction graph decisions and final validation;
`/skill:implement-task` owns each task's execution and checkpoint loop.

Prepare → Implement → Validate. Reuse the one overall feature direction approval for the
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

## 1. Ensure an initialized feature

For a new Linear-backed feature or explicit requirements, invoke
`/skill:init-feature` to load the source, capture and approve the original
direction, create/reconcile the Scaffold graph, design/decompose all issues
and run `design-finish`. Do not duplicate that initialization logic here.
If an existing feature is already prepared, authenticate its persisted state,
original approval, branch, baseline, task graph and design phase. Continue
without reinitializing or requesting another approval. If the graph is still
in Design, or feature approval is missing, delegate to `/skill:init-feature`
to finish preparation; never claim a null selection means completion.

This skill owns the **multi-task implementation loop** and final feature
validation only. Preparation is separate from execution: `init-feature`
does not apply code or start tasks, and `feature-delivery` must not execute
before verified `design-finish`. Reuse the single retained direction grant
through task checkpointing, recovery and final validation.

## 2. Implement upward and process discoveries

Use `select` for one eligible issue. Recover its current design and inspect source.
Do not redo design approvals or request execution confirmation. On the first attempt,
the adapter assembles persisted issue acceptance criteria, constraints and the complete
approved design into versioned review context. Supply only additional applicable
constraints and established interfaces in `requirements` (or an empty string); do not
manually reconstruct the design suffix or retype its formatting; original feature criteria remain authoritative. Copy `task.designRef` exactly from the scoped issue/select
response; it is the feature's `design_ref`, not the issue design reference. A branch
or reference mismatch requires inspecting current state, not another approval.

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

## 3. Delegate one issue to implement-task

After `design-finish`, select the next eligible issue through Scaffold and
load `/skill:implement-task` with the exact `featureId`, `taskId`,
approved design and current context. Pi remains the sole orchestrator: the
task skill owns implementation operations, targeted check selection, bounded
Conductor attempts, in-scope corrections, evidence inspection and verified
checkpoint completion for **one issue only**. Its native execution mechanism
is still `execute_and_review`; the extension applies source operations,
runs checks and independent review, records authentic completion and commits
the exact reviewed tree. One invocation of the native tool is one attempt,
not an entire task or a feature.

On `stage: COMMITTED`, inspect the returned `nextBaseRef` and select the
next eligible task. Do not repeat completion/checkpoint operations. When the
task skill returns an unresolved blocker, missing dependency, oversized scope
or NEEDS_DESIGN requiring graph changes, stop task execution and use the
discovery exit hatch above: suspend with evidence, design/decompose remaining
work, `design-finish`, complete prerequisites, and `resume_issue` with an
authenticated handoff. Do not restart the feature, discard partial changes or
reset prior attempts. A review failure inside a bounded task is normally
handled by implement-task; a new graph is a feature-level decision.

Task-level `previousAttempt`, `repair_check`, targeted checks, correction,
checkpoint recovery, retained receipts, meaningful test evaluators and retry
details live in `/skill:implement-task`. Task completion requires authentic
PASSED evidence and exact Git checkpoint. The full repository test suite is
reserved for `validate_feature`, not repeated for each leaf or parent by
default. Original feature criteria and all completed descendants remain intact.
There is **no per-issue attempt limit**; evidence-backed stall detection and
resource/infrastructure pauses govern continuation.

## Checkpoints, recovery and final review

Feature delivery ensures each dependency and parent issue is independently
completed and checkpointed before final validation. Per-task Git tree and
index recovery is delegated to `/skill:implement-task` and its native tools.
Feature-level suspension, dependency changes, rebase reconciliation and
final validation remain this workflow's responsibility.

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

If a clean user commit lands after authorization but before any task starts, or Git no longer matches the feature boundary, run `inspect_feature_drift`; for clean user commits between tasks it directs you to `adopt_foreign_commits`, which needs the user's explicit approval of the exact recorded head and new head and is not rebase recovery. Never edit Scaffold or recreate the feature to bypass a baseline mismatch.

For a user-performed rebase use `rewrite_feature_history` between tasks; if a task is active, `suspend_issue` it first and
`resume_issue` it afterwards. Preserve original receipts, baseline, criteria and budget. The retained feature authority covers
verification/recovery, not performing a rebase or arbitrary history rewriting. See extensions/execute-and-review/README.md for exact inputs.


## Scoped feature state and handoffs

Use `scaffold_tasks summary`, `design-select`, `select` and a scoped
`issue` query for the current phase; never treat null selection as proof of
completion. Within a selected issue, `/skill:implement-task` owns detailed
`prepare_issue_handoff`, `inspect_issue_attempt`, `previousAttempt`
and retained evidence inspection. Only Scaffold owns graph lifecycle state;
returning from task implementation does not authorize creation of unrelated
work. Feature delivery coordinates material approval amendments, suspended
issue prerequisites and final review corrective issues without losing history.

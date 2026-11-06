---
name: feature-delivery
description: >
  End-to-end autonomous feature delivery: approve direction, design and decompose
  Scaffold issues, implement through Conductor, review, checkpoint and validate.
---

# Autonomous feature delivery

This skill orchestrates the full approved feature lifecycle. For the independently
invocable design capability and its engineering contract, load `/skill:design`.
This workflow consumes that contract for each scoped issue, but alone owns
Scaffold lifecycle transitions, execution authority, retry/recovery, checkpoints
and final feature validation.

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
Use `summary`, then `design-select` for
one eligible issue. Inspect only that issue's scoped context, ancestor contracts,
inherited dependencies and relevant source. Make detailed engineering decisions
within the approved direction yourself. Share concise progress when useful;
do not turn design previews into additional approval requests.

### One bounded design pass

Use `/skill:design` to produce the issue's bounded engineering contract; persist
that contract using the existing `design-record` operation. The design skill
itself must not initialize Scaffold, authorize implementation or invoke execution.


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

## 4. Delegate one issue to implement-task

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

For user-performed rebases use `reconcile_feature_rebase` between tasks or
`recover_interrupted_task_rebase` for an interrupted chain. Preserve original
receipts, baseline, criteria and budget. Inspect retained evidence using the matching
inspection tools; only an authenticated handoff changes the continuation baseline.
The retained feature authority covers verification/recovery, not performing a rebase
or arbitrary history rewriting. See extensions/execute-and-review/README.md for exact inputs.


## Scoped feature state and handoffs

Use `scaffold_tasks summary`, `design-select`, `select` and a scoped
`issue` query for the current phase; never treat null selection as proof of
completion. Within a selected issue, `/skill:implement-task` owns detailed
`prepare_issue_handoff`, `inspect_issue_attempt`, `previousAttempt`
and retained evidence inspection. Only Scaffold owns graph lifecycle state;
returning from task implementation does not authorize creation of unrelated
work. Feature delivery coordinates material approval amendments, suspended
issue prerequisites and final review corrective issues without losing history.

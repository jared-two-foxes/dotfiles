---
name: scaffold
description: >
  Persist Pi's recursive issue graph, approved designs, dependencies, phase
  transitions and verified lifecycle using native scaffold_tasks. Scaffold stores
  state; Pi designs and sequences; Conductor executes and verifies.
---

# Persistent issue graph

Use native **`scaffold_tasks`**, backed by the installed `scaffold` executable.
Pi owns reasoning, approvals, decomposition and sequencing. Scaffold owns its
atomic locked state at `.scaffold/tasks.json`, dependencies and lifecycle history.
Never edit state files directly. Native tools never automatically select the next
issue, generate code, retry implementation or claim verification from bookkeeping.
Use `/skill:design` for the complete Research → Design → Implement workflow.

The user provides a ticket; a feature retains its original objective, criteria,
branch and baseline; all graph nodes are issues. Existing API names remain
`task`, `task_id` and `tasks` for compatibility. Issue origin records whether it
came from the ticket, design, review or an implementation discovery. The legacy
criteria stack is separate; never mirror this graph into it.

## Initialize and design downward

Every call supplies `operation` and explicit `feature_id`. Repository scope is
Pi's current Git root; there is no arbitrary repo path or implicit current issue.

For a new feature initialize from the agreed ticket scope:

```json
{"operation":"init","feature_id":"F1","payload":{"id":"F1","title":"Client activity","objective":"Record and display activity","acceptance_criteria":["Recorded activity is displayed"],"context":"Exact agreed ticket, constraints, original full Git baseline and feature branch","design_ref":"sha256:context","baseline":"<full original SHA>","branch":"feature/activity"}}
```

The adapter replaces `sha256:context` with the digest of the exact context. Retain
the returned reference. A root issue with the feature ID is created automatically;
full system design is not a prerequisite to initialization. Context/digest mismatch
blocks recovery. Existing immutable `path@full-commit-SHA` designs remain supported.

Call `summary`, then `design-select` to select an undesigned issue below an approved
parent/prerequisite contract. Selection never claims or starts work. Design only
this issue and its immediate responsibilities; use delegated authority from the overall feature direction approval.

If it requires smaller units, `decompose` with an atomic array of child definitions.
Every definition needs ID, title, narrow objective, acceptance_criteria, relevant
context, inherited constraints and explicit dependencies (`[]` when none). Put
`Verification:` strategy, edge cases and expected outcomes in context. Optional
`origin: {kind: "ticket"|"design"|"review"|"discovery", reference: "<issue/evidence>"}`
records provenance. Forward dependencies within the batch are allowed; cycles,
missing dependencies and duplicates fail atomically. Children inherit ancestor
dependencies; downstream issues depend on the parent. Completed descendants remain
intact. Definitions are immutable; designs are separately retained records.

Record the confirmed design after adding its immediate children:

```json
{"operation":"design-record","feature_id":"F1","task_id":"F1","payload":{"summary":"Approved responsibility boundaries, interfaces, decisions and constraints","verification":"Actual checks and integration criteria","approval":"Agent-designed under overall feature authorization <actual reference>","disposition":"decomposed"}}
```

A leaf uses `disposition: "leaf"`. Scaffold binds the immediate children into a
content-addressed record; the adapter checks its digest. Reopening a design retains
old designs and invalidates unfinished descendant designs so they receive fresh
agent design. Completed designs/evidence are preserved. Record the actual overall authorization reference; label issue designs as agent-authored.

Continue `design-select` until all required nodes have confirmed designs. Then
`design-finish` transitions the graph to implementation. It refuses incomplete
designs. A null selection alone never grants execution authority.

## Implement upward

Use `summary` and `select` to select an eligible issue. **`next` returning null does not
necessarily mean the feature is complete.** It also returns null during Design,
while an issue is active, when a checkpoint is missing or when work is suspended.
Inspect the complete state. Recover its approved design and include the exact
Design-specified suffix in fixed Conductor requirements. The retained overall direction approval covers design and execution; do not ask per issue.

| Operation | Additional fields | Meaning |
| --- | --- | --- |
| `summary`, `select`, `design-select`, `design-finish` | none | Scoped phase/selection or explicitly finish design |
| `issue` | task_id | Current issue and relevant contracts |
| `list` | none | Explicit full-state diagnostics |
| `add` | payload: issue definitions | Add top-level/dependent corrections during Design |
| `decompose` | task_id, payload: children | Add immediate children during Design |
| `design-record` | task_id, payload: approved design | Persist delegated design decisions before implementation |
| `start` | task_id | Start one ready issue during Implement |
| `complete` | task_id, payload: evidence | Complete from actual PASSED evidence |
| `block`, `fail`, `retry` | task_id, reason | Explicit reconciled lifecycle transition |
| `design-reopen` | optional task_id, payload: reason and optional suspension reference | Return affected work to Design |
| `checkpoint-record` | task_id, payload: commit and reference | Native checkpoint bookkeeping after authentic Git commit |
| `issue-resume` | task_id, payload: reference and handoff | Native restoration bookkeeping after authenticated source handoff |

Only one issue may be active. Prerequisites and children must be completed; every
completed issue must have a checkpoint before another starts. Parents remain open
after children finish and need their own Conductor verification and checkpoint,
including an empty commit when no integration edits are needed.

## Evidence, checkpoints and final validation

Scaffold validates structure and association, not evidence authenticity.
**Scaffold's deterministic validation is not trusted Conductor verification.**
Inspect actual successful execution, checks with meaningful coverage, independent
APPROVED review and exact feature/issue/design/tree through
`inspect_conductor_evidence`. Missing/tampered/uncertain evidence leaves work open.
Complete using the actual receipt:

```json
{"operation":"complete","feature_id":"F1","task_id":"storage","payload":{"feature_id":"F1","task_id":"storage","result":"PASSED","source":"conductor","reference":"<actual retained reference>","summary":"Actual checks and independent review passed"}}
```

Then call feature-authorized `checkpoint_verified_task`. It authenticates the receipt,
commits the exact tree with Git provenance and records the checkpoint in Scaffold.
Do not invoke `checkpoint-record` manually as a substitute. If bookkeeping was
interrupted after committing, retry the native checkpoint with the same reference.
A checkpoint grants no execution, push or publishing authority. After all nodes
are completed/checkpointed, use approved `validate_feature`; all completed nodes
or `next: null` alone do not prove the root ticket has been delivered.

## Discoveries and interrupted work

Review findings within the approved solution stay in the same issue's correction
chain. New responsibilities/prerequisites return to Design. For unfinished active,
blocked or failed attempts use native feature-authorized `suspend_issue`: it preserves
source, staging, untracked files, all receipts and attempt counts in saved Git refs
and a retained stash, then reopens design on a clean baseline. Never stash/reset
from Bash or invoke `design-reopen` with a fabricated suspension reference.

Decompose the remaining work, redesign the affected contract within scope, design new issues,
finish the graph design and implement/checkpoint eligible prerequisites. Use
`resume_issue` to restore the saved work onto authenticated checkpoints; it returns
an explicit handoff and fixed continuation fields. Complete native bookkeeping,
`start` the same issue, continue within the retained overall feature authority and use that handoff as
`previousAttempt`. Three consumed attempts mean attempt four next. READY never
means PASSED. Conflicts or exhausted budgets block with evidence retained.

Without unfinished implementation use `design-reopen` directly. Failed final
review creates new dependent issues after completed nodes; preserve all completed
nodes, commits and original criteria. Environmental failures are blocks, not
invented code issues. Do not use decomposition or retry to reset attempt budgets.

On interruption reload the issue handoff and scoped summary/issue state, then
inspect relevant Git source/index and receipt references before mutating. Native
validators authenticate complete state and checkpoint history. Failed commands/timeouts
can follow a persisted mutation; query summary/issue before replaying; request full list only for unresolved diagnostics. For suspension or restore
use the returned suspensionRef/handoffRef to recover the same operation. Never
initialize a replacement feature to hide failures.

## Compatibility

Features without an issue graph require explicit migration of their original scope, source and receipts before implementation. The task store uses schema v2 exclusively; older state is rejected without modification. Upgrade Scaffold and Pi together; an older Scaffold rejects the new init/operations before
implementation. Legacy `scaffold stack list`, `scaffold status` and
`scaffold fetch-ticket ID` remain read-only inspection aids outside this graph.


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


## Single feature direction authority

Use approve_feature_direction once after presenting the overall direction and local
delivery scope. This is the sole confirmation; no separate conversational yes/no,
per-issue design approval or implementation confirmation. All design-record approval
strings must identify delegated authority and the actual reference, never claim the
user individually approved an issue. Local checks, independent reviews, verified
commits and recovery reuse that authority across sessions. Material changes outside
the agreed objectives/constraints return to the user. Final feature review is mandatory.

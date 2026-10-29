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
{"operation":"init","feature_id":"F1","payload":{"id":"F1","title":"Client activity","objective":"Record and display activity","acceptance_criteria":["Recorded activity is displayed"],"context":"Exact agreed ticket, constraints, original full Git baseline and feature branch","design_ref":"sha256:context","workflow":"recursive-issues/v1","baseline":"<full original SHA>","branch":"feature/activity"}}
```

The adapter replaces `sha256:context` with the digest of the exact context. Retain
the returned reference. A root issue with the feature ID is created automatically;
full system design is not a prerequisite to initialization. Context/digest mismatch
blocks recovery. Existing immutable `path@full-commit-SHA` designs remain supported.

Call `list`, then `design-next` to select an undesigned issue below an approved
parent/prerequisite contract. Selection never claims or starts work. Design only
this issue and its immediate responsibilities; obtain user confirmation.

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
{"operation":"design-record","feature_id":"F1","task_id":"F1","payload":{"summary":"Approved responsibility boundaries, interfaces, decisions and constraints","verification":"Actual checks and integration criteria","approval":"What the user explicitly approved","disposition":"decomposed"}}
```

A leaf uses `disposition: "leaf"`. Scaffold binds the immediate children into a
content-addressed record; the adapter checks its digest. Reopening a design retains
old designs and invalidates unfinished descendant designs so they receive fresh
confirmation. Completed designs/evidence are preserved. Never invent approval.

Continue `design-next` until all required nodes have confirmed designs. Then
`design-finish` transitions the graph to implementation. It refuses incomplete
designs. A null selection alone never grants execution authority.

## Implement upward

Use `list` and `next` to select an eligible issue. **`next` returning null does not
necessarily mean the feature is complete.** It also returns null during Design,
while an issue is active, when a checkpoint is missing or when work is suspended.
Inspect the complete state. Recover its approved design and include the exact
Design-specified suffix in fixed Conductor requirements. Keep separate design and execution
approvals; obtain fresh execution approval for each issue.

| Operation | Additional fields | Meaning |
| --- | --- | --- |
| `list`, `next`, `design-next`, `design-finish` | none | Inspect/select or explicitly finish design |
| `add` | payload: issue definitions | Add top-level/dependent corrections during Design |
| `decompose` | task_id, payload: children | Add immediate children during Design |
| `design-record` | task_id, payload: approved design | Persist confirmation before implementation |
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

Then call UI-authorized `checkpoint_verified_task`. It authenticates the receipt,
commits the exact tree with Git provenance and records the checkpoint in Scaffold.
Do not invoke `checkpoint-record` manually as a substitute. If bookkeeping was
interrupted after committing, retry the native checkpoint with the same reference.
A checkpoint grants no execution, push or publishing authority. After all nodes
are completed/checkpointed, use approved `validate_feature`; all completed nodes
or `next: null` alone do not prove the root ticket has been delivered.

## Discoveries and interrupted work

Review findings within the approved solution stay in the same issue's correction
chain. New responsibilities/prerequisites return to Design. For unfinished active,
blocked or failed attempts use native UI-authorized `suspend_issue`: it preserves
source, staging, untracked files, all receipts and attempt counts in saved Git refs
and a retained stash, then reopens design on a clean baseline. Never stash/reset
from Bash or invoke `design-reopen` with a fabricated suspension reference.

Decompose the remaining work, reconfirm the affected contract, design new issues,
finish the graph design and implement/checkpoint eligible prerequisites. Use
`resume_issue` to restore the saved work onto authenticated checkpoints; it returns
an explicit handoff and fixed continuation fields. Complete native bookkeeping,
`start` the same issue, obtain ordinary execution approval and use that handoff as
`previousAttempt`. Three consumed attempts mean attempt four next. READY never
means PASSED. Conflicts or exhausted budgets block with evidence retained.

Without unfinished implementation use `design-reopen` directly. Failed final
review creates new dependent issues after completed nodes; preserve all completed
nodes, commits and original criteria. Environmental failures are blocks, not
invented code issues. Do not use decomposition or retry to reset attempt budgets.

On any interruption inspect full state, persisted phase/designs, Git source/index,
receipts and actual checkpoint history before mutating. Failed commands/timeouts
can follow a persisted mutation; `list` before replaying. For suspension or restore
use the returned suspensionRef/handoffRef to recover the same operation. Never
initialize a replacement feature to hide failures.

## Compatibility

Features without `workflow` retain their schema-v1 task lifecycle and receipt-based
design recovery. Do not silently opt an active feature into this workflow. New workflows upgrade the shared task store to schema v2; older binaries stop
instead of silently ignoring phase gates. Upgrade Scaffold and Pi together; an older Scaffold rejects the new init/operations before
implementation. Legacy `scaffold stack list`, `scaffold status` and
`scaffold fetch-ticket ID` remain read-only inspection aids outside this graph.

---
name: scaffold
description: >
  Use Pi's native scaffold_tasks tool for persistent feature tasks,
  dependencies, lifecycle history and supplied verification evidence.
  Scaffold stores state; Pi reasons and Conductor executes and verifies.
---

# Persistent feature tasks

Use **`scaffold_tasks`**, backed by the existing `scaffold` executable on PATH
with the Phase 1 `tasks` API (schema_version 1). All operations run at the root
of Pi's current Git repository, even from a subdirectory. There is no repo path
parameter, second state store, or in-memory current-task pointer. State remains
in `.scaffold/tasks.json`; do not edit it directly. The adapter also rejects
symlinked state paths. Scaffold's own atomic writes and locking own persistence.

Pi owns design, decomposition, sequencing and recovery decisions. Scaffold owns
persistence, dependency checks and lifecycle validation. Conductor owns application
source execution, build/test checks and independent review invocation. The native
Scaffold tool never generates code, invokes Conductor, retries implementation or
automatically advances a task.

## Interface

Every call requires `operation` and `feature_id`. Preserve explicit feature and
task IDs from requirements and results; never infer an implicit current task.
Unknown/irrelevant arguments are rejected. Payloads are structured JSON values,
not JSON strings or filenames. The adapter sends them on stdin with `--input -`.

| operation | Other required fields | Returned data |
| --- | --- | --- |
| `init` | `payload`: feature definition | Full feature |
| `add` | `payload`: nonempty array of task definitions | Full feature |
| `list` | none | Full feature and all task histories |
| `next` | none | Full feature and eligible `task` or `null` |
| `start` | `task_id` | Updated task |
| `complete` | `task_id`, `payload`: evidence | Updated task with evidence in history |
| `block` | `task_id`, `reason` | Updated task |
| `fail` | `task_id`, `reason` | Updated task |
| `retry` | `task_id`, `reason` | Updated task |
| `decompose` | `task_id`, `payload`: nonempty array of children | Full feature |

Feature definitions require `id`, `title`, `objective`, `design_ref` and nonempty
`acceptance_criteria` (string array). Use an accessible immutable reference to the
approved feature design. Optional fields: `context` (string), `constraints`
(string array). Task definitions require the same fields except `design_ref`;
they also accept `dependencies` (unique task IDs within this feature). Put enough
context and constraints in definitions for a fresh session to understand them.
Definitions are immutable in v1.

Tool results have `ok`, `operation`, `feature_id`, an explicit `task_id` when
requested, and either `data` (the original schema_version 1 response) or structured
`reason`/`message`. Nonzero CLI failures include `exit_code`, bounded `stderr` and
`scaffold_error` when stderr is JSON. Invalid input, missing executables, malformed
responses and unsupported versions are failures, never successful verification.
A timeout, cancellation or invalid response can follow a persisted mutation:
inspect with `list` before deciding whether to retry. Never blindly replay writes.

## Explicit usage example

These are native tool argument objects, not shell commands or an automatic loop.
Only initialise from an approved design when task tracking is requested/agreed.
Creating state or starting a task grants no source execution approval.

```json
{"operation":"init","feature_id":"F1","payload":{"id":"F1","title":"Client activity","objective":"Record and display activity","design_ref":"docs/activity.md@approved-commit","acceptance_criteria":["Activity is recorded and displayed"]}}
```

Persist independently understandable, implementable and verifiable tasks. One
atomic add can reference other tasks in that batch; Scaffold rejects cycles and
missing dependencies.

```json
{"operation":"add","feature_id":"F1","payload":[{"id":"domain","title":"Activity model","objective":"Define activity data","acceptance_criteria":["Activity includes client ID and timestamp"],"constraints":["No database dependencies"]},{"id":"storage","title":"Activity persistence","objective":"Store activity through the adapter","acceptance_criteria":["Recorded activity can be retrieved"],"dependencies":["domain"]}]}
{"operation":"next","feature_id":"F1"}
{"operation":"start","feature_id":"F1","task_id":"domain"}
{"operation":"list","feature_id":"F1"}
```

`next` only reads/selects; it does not start work. **`next` returning null does not
necessarily mean the feature is complete.** Inspect the full feature for
`in_progress`, `blocked`, `failed` or unfinished `decomposed` tasks. Even all tasks
completed does not itself prove final feature-level validation happened.

For implementation load `/skill:design`. Retain separate design and execution
approvals and the existing single-task Conductor correction behavior. Only an
approved `execute_and_review` call can apply application source changes and run
implementation verification. Design owns feature decomposition, task selection and recovery; this tool does
not orchestrate execution or final feature validation. Complex work must be planned
and persisted before Executor authoring. See `/skill:design` for the full handoff.

## Recording trusted verification

After an actual successful Conductor verification covering this task's approved
criteria, inspect its result and preserve an accessible durable result reference.
For Pi task execution supply the exact feature/task/design binding to Conductor.
Its returned `evidence.reference` identifies the retained request, result, Git
fingerprints and provenance. Read it with `inspect_conductor_evidence`; check exact
identity, fixed requirements, tree, successful checks and independent APPROVED
review, and inspect actual test output. Structural validation is necessary but
cannot prove meaningful tests ran. Missing, invalid, mismatched or uncertain
receipts leave work unfinished. Never use a transcript pointer as retained proof.
Record the evidence and complete the explicit task with a single call:

```json
{"operation":"complete","feature_id":"F1","task_id":"domain","payload":{"feature_id":"F1","task_id":"domain","result":"PASSED","source":"conductor","reference":"durable-result-reference-for-domain-attempt-1","summary":"Actual build, tests and independent review passed for the domain criteria"}}
```

The reference above is a placeholder: replace it with the real retained result.
Do not invent a reference, summary or PASSED result. If a successful result or
usable reference is unavailable, leave the task unfinished and explain why.
There is no separate evidence-write API: `complete` appends evidence to history
and changes the task to `completed` atomically. It requires `in_progress` and
completed prerequisites. An identical completion replay is a no-op; different
evidence for a completed task is rejected.

**Scaffold's deterministic validation is not trusted Conductor verification.**
Scaffold checks evidence structure, task association and transitions only. It does
not execute, read or authenticate the evidence or its reference. A tool response
with `ok: true` means a lifecycle operation succeeded; it never proves tests ran
or review passed. Pi must establish trust from the actual verification result.
Do not map NEEDS_DESIGN, BLOCKED, missing results or a well-formed JSON object to
PASSED. Standalone review cannot substitute for Conductor verification.

## Blocked, failed and oversized work

- `block` records a reason for pending, in-progress or decomposed work. Blocking
  a parent pauses descendant eligibility.
- `fail` records a failed in-progress task; retain the actual failure reason.
- `retry` explicitly returns in-progress/interrupted, blocked or failed work to
  pending (or decomposed if it has children). Inspect source/state and decide on
  recovery first. This does not retry execution or authorise implementation.
- `decompose` preserves an oversized parent's definition/history and adds required
  children. Pending, in-progress, blocked, failed and decomposed parents can be
  split; completed parents cannot. It explicitly resumes blocked/failed work via
  children. Repeated calls append uniquely identified children; a child can itself
  be decomposed. Ancestor dependencies still gate children. Keep completed work
  intact and put only remaining unverified work into child definitions.

```json
{"operation":"block","feature_id":"F1","task_id":"storage","reason":"Adapter contract needs clarification"}
{"operation":"retry","feature_id":"F1","task_id":"storage","reason":"Contract clarified; explicitly resume"}
{"operation":"decompose","feature_id":"F1","task_id":"storage","payload":[{"id":"write","title":"Store activity","objective":"Implement adapter write","acceptance_criteria":["Activity is stored"]},{"id":"read","title":"Read activity","objective":"Implement adapter query","acceptance_criteria":["Stored activity can be queried"],"dependencies":["write"]}]}
```

Parents do not complete automatically when children finish. A parent becomes
eligible for `start` after children/prerequisites complete, then requires its own
verification against original criteria and explicit `complete`. Downstream tasks
continue to depend on the parent, not just its children.

## Resume after a session interruption

Use the same target repository and feature ID. First call `list`; recover the
approved design reference, definitions, dependencies, statuses and history from
that response. Inspect application source and any retained verification artifacts.
An `in_progress` task is interrupted work, not automatically a failed or verified
task. Decide explicitly whether to continue it, record a failure/block, retry or
decompose. Never initialise the feature again, erase state, assume conversation
history is authoritative, or implicitly start whatever `next` selects. Inspect
existing work before asking for new execution approval. No manual CLI invocation
is required for these task operations.

## Supported legacy inspection

The CLI still supports read-only `scaffold fetch-ticket ID`, `scaffold status`
and `scaffold stack list` when useful for ticket/criteria inspection. They are
separate from feature tasks and not exposed by `scaffold_tasks`. Do not mirror
feature tasks into the legacy stack, pop frames as proof of verified completion,
or invoke a retired Scaffold execution pipeline. Source implementation always
uses Design → approved execute_and_review → Conductor.

## Approved design and complete task definitions

For new Design plans put the exact approved design in feature `context` and use
`design_ref: "sha256:context"` on `init`. This Pi sentinel is replaced with a real
SHA-256 before CLI invocation. Returned `design_ref` is the stable reference; the
adapter checks that digest on feature responses. Existing immutable Git revision
references remain supported. Never overwrite approved architecture silently.

Every Design task includes objective, acceptance_criteria, relevant context,
inherited constraints, stable id and explicit dependencies. Put `Verification:`
strategy in `context`; there is no extra verification field in Scaffold's schema.
An empty dependency list is explicit. Add dependent definitions as one batch;
Scaffold owns graph validation. Do not mutate task JSON directly.

The next eligible task may still require a Git checkpoint. State eligibility never
authorises execution across previous uncommitted task changes. On recovery inspect
receipts under `git rev-parse --git-path pi-conductor-evidence`, including unfinished
STARTED intent records, before deciding whether to continue, retry, block or split.
A STARTED record proves only an attempt began, never that operations finished.

Before task execution, `.scaffold/` bookkeeping must be ignored and untracked so
it cannot enter Conductor's review diff. Inspect existing ignore rules. If state
is visible to Git, stop and have an authorised ignore rule established; do not
silently edit `.gitignore`, Git configuration or index. The task-bound preflight
returns `SCAFFOLD_REVIEW_SCOPE` for visible state. A source ignore-file change,
if needed, follows its own normal approval and checkpoint workflow.

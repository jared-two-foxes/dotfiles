---
name: conductor
description: >
  Execute an approved, exact executor operations JSON through the Pi
  execute_and_review tool and the deterministic Conductor CLI. Use for
  design-first implementation with explicit approval, build/test checks,
  and independent review. Used by the Design implementation workflow.
---

# Conductor — design-first execution

Use this skill as the lower-level Conductor execution reference. For the
full collaborative architecture conversation, load `/skill:design` first;
that skill owns decisions, design confirmation and executor authoring.
Conductor is the sole implementation path; never substitute direct edits.

Explicitly requested Git/GitHub publishing is a separate instruction-level
exception governed by `SYSTEM.md`; it does not run through Conductor. Outside
an active verification/correction loop, it may prepare selected feature-branch
commits, push with Git, and create/update PRs with `gh pr create` / `gh pr edit`.
Never merge PRs, enable auto-merge, enqueue PRs for merging, or use equivalent
API, script, workflow or delegated actions. Preserve protected branches and
unrelated working/staged changes. Publishing does not authorize source edits,
builds or tests.

## Preconditions

- The native Pi extension `extensions/conductor/index.ts` must be loaded,
  exposing the `execute_and_review` tool. If unavailable, stop; never
  substitute direct edits or invoke Conductor manually.
- The `conductor` executable must be on PATH (or set `CONDUCTOR_BIN`).
- The target directory must be a Git repository.
- Confirm both a real build command and a real test command as arrays of
  executable and arguments. No shell syntax or invented commands.
- The Design agent must inspect the exact source before authoring executor
  operations and must produce **complete executor operations JSON** with an
  `operations` array. Do not pass a plan, removed `patch` variants, or
  pseudocode.

## Approval gates

1. Inspect the repository and discuss material design decisions iteratively,
   using focused code/text examples with changed portions marked, including
   new or changed data structures and how their data is created and used.
2. Present the code-led implementation preview and fixed acceptance criteria.
   Obtain explicit design approval before generating executor operations.
3. Prepare complete executor JSON consistent with the approved design. If a
   new consequential choice emerges, return to Design for renewed approval.
4. Present a short execution confirmation: scope, affected files and build/test
   commands. Offer full operations on request; do not display JSON by default.
   Obtain explicit permission **to execute**, separate from design approval.
5. Capture the full SHA from `git rev-parse HEAD` as `baseRef` once. Inspect
   `git status --porcelain`; disclose unrelated working changes. Keep the
   same base SHA and requirements across correction attempts.

## Execution

Call **only** `execute_and_review` with:

- `input`: JSON string containing the exact `operations` array.
- `requirements`: the approved design and acceptance criteria.
- `baseRef`: original full 40-character commit SHA.
- `buildCommand`, `testCommand`: executable-and-argument arrays.
- `reviewModel` (optional): independent review model.

The tool validates the Git baseline, forwards one
`conductor.request/v1` to `conductor run --request -`, and returns an
`opencode.execute_and_review.result/v1`-compatible envelope. The schema
name is historical; Pi consumes the same result contract.

- **PASSED**: report the actual checks and review; do not claim a commit was
  made or that tests ran unless the output demonstrates it.
- **NEEDS_DESIGN**: inspect current working tree and feedback. Prepare a
  minimal new executor input against the *current* state, retaining the
  original baseline and requirements. Ask before architectural changes.
- **BLOCKED**: stop, explain the environment or protocol failure and inspect
  working tree before retrying.

Maximum five total attempts, stopping after two identical failures without
progress. Never silently clean, reset, commit or push. Do not run direct
`edit`/`write` operations or call `executor`/`review-cli` to bypass the
Conductor gate. Do not commit, change branches or otherwise change HEAD during
an active verification/correction loop. Keep the original baseline fixed;
finish or explicitly stop the loop before a separately requested publishing
workflow.

## Limitations

Conductor currently does not prove that any tests executed. For Pi task-bound
calls the adapter captures source/index after the test command and blocks PASSED
if that review-boundary fingerprint differs afterwards. Non-task callers retain
the original contract; concurrent external writers remain unsupported. Inspect test output and
report these limitations honestly. The Pi adapter has an overall 15-minute
subprocess deadline but Conductor does not yet enforce per-check timeouts.

## Persisted task attempts

Design owns decomposition and lifecycle decisions. For Scaffold tasks also pass
`task: {featureId, taskId, designRef}` and task-scoped `requirements`: current
criteria, applicable architectural constraints and established interfaces to
preserve. Future feature criteria are deferred; final feature validation is later.
Pass `previousAttempt` for corrections, using the actual preceding receipt.
Initial task attempts require a clean implementation tree (excluding `.scaffold`
bookkeeping). A new eligible task with earlier uncommitted changes returns
`CHECKPOINT_REQUIRED`; finish the loop, record completion and use separately authorized `checkpoint_verified_task`.
No HEAD changes during a correction loop.

The adapter retains a STARTED intent before execution and a content-addressed
receipt afterwards under Git metadata, outside the review diff. Receipts include
task/design identity, original request, raw response, outcome, attempt number and
before/after tree fingerprints. `evidence.reference` is a repository-local digest
reference, not a fabricated URL. Use read-only `inspect_conductor_evidence` to read
it across sessions and compare the current tree. Do not remove receipts while
Scaffold refers to them. They survive Pi restarts in this checkout, but are not
pushed/cloned with Git; preserve them separately if moving the workspace. Local
hashes detect corruption, not malicious rewriting or independent test quality.

A bound PASSED without successful execution, build/test exit codes and APPROVED
review becomes BLOCKED. Pi must additionally inspect output for actual relevant
checks before completing the exact Scaffold task. Retention failures return
BLOCKED with the actual result when available; never invent completion evidence.
For NEEDS_DESIGN preserve the task as in_progress through bounded corrections;
record fail when stopping for defects/attempt limits, block for unresolved
conditions, or decompose remaining oversized work after reconciliation. Receipt
chains preserve the five-attempt ceiling; repeated identical failures without
progress still require Pi to stop. No retries or lifecycle mutations live here.


## Local checkpoints after completion

After inspected PASSED evidence and matching Scaffold completion, end the active
correction loop. Design may invoke `checkpoint_verified_task` with separate manual
or session-scoped feature checkpoint authorization. This tool never invokes
Conductor, chooses tasks, pushes or opens PRs. It checks the actual retained
request/result, clean-start correction chain, full verified Git tree and Scaffold
history; an Executor operation list alone does not establish commit scope.
Old receipts without Git trees and a matching post-test review-boundary snapshot
cannot authorize checkpoints. Preserve evidence;
reconcile and obtain fresh verification under an explicitly approved task loop.

The commit trailer binds feature/task/design, receipt, original feature baseline,
task baseline, tree and branch. A pending ref under `refs/pi-checkpoints/` is
created atomically with the branch update and removed after index finalization.
On resume inspect these, actual HEAD/index/worktree, Scaffold state and receipts.
A matching checkpoint explains a committed source snapshot even though the old
uncommitted fingerprint differs. Only current-HEAD recovery is automatic. Never
replay older checkpoints or discard unrelated staged changes. Existing locks need
explicit resolution after checking process ownership. New sessions require fresh
checkpoint authorization. See Design for the complete recovery policy.

`.scaffold/` must already be ignored and untracked. The tool never edits ignore
rules, configuration or local excludes. If needed, establish an explicitly
approved ignore rule separately before implementation. Local receipts are under
Git metadata and never enter implementation commits. Snapshots use private indexes;
submodules, conflicts, sparse/skip-worktree and assume-unchanged entries fail closed.
The adapter remains backward compatible for non-task callers and retains the
five-attempt correction ceiling. Conductor itself is unchanged.

Task-bound requests transparently wrap the original approved test command in a
Pi-local Node runner, forwarding stdout/stderr and exit status. On test success
it captures a Git tree/fingerprint before independent review. Final fingerprints
must match or the adapter returns `REVIEW_SNAPSHOT_CHANGED`. Original commands
remain in the receipt and fixed throughout corrections; non-task callers keep
the existing protocol. No Conductor, Review or Executor changes are required.

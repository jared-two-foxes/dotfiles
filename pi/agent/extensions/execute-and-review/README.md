> Current Pi continuation API: see [RECOVERY.md](RECOVERY.md). Continuations inherit
> context from receipts and Scaffold; no exact requirements-string copy or lifetime
> attempt allowance is required. Historical wire examples below remain compatible.

# Pi delivery extension

`index.ts` registers `execute_and_review` and the delivery and recovery tools.
The workflow in `delivery.mjs`, `adapter.mjs`, and `pipeline.mjs` owns task
binding, continuation, verification policy, independent review, and checkpoint
authorization. `protocol.mjs` prepares the Executor and Review inputs and
authenticates their delivery evidence.

The workflow uses the sibling [Conductor client](../conductor/README.md) to run
the plan. The Executor and [Review](../review/README.md) clients describe their
CLI invocations and validate their results. Execute and Review assembles those
steps and owns authorization, evidence, and checkpointing.

## Native Pi installation

Install these directories as siblings. The Executor directory supplies an
internal client module. Pi tool registration lives in the other extensions.

```
~/.pi/agent/extensions/conductor/
~/.pi/agent/extensions/execute-and-review/
~/.pi/agent/extensions/executor/
~/.pi/agent/extensions/review/
```

For a dotfiles checkout on Windows, a copy-based installation is:

```powershell
Copy-Item -Recurse -Force .\pi\agent\extensions\conductor "$HOME\.pi\agent\extensions"
Copy-Item -Recurse -Force .\pi\agent\extensions\execute-and-review "$HOME\.pi\agent\extensions"
Copy-Item -Recurse -Force .\pi\agent\extensions\executor "$HOME\.pi\agent\extensions"
Copy-Item -Recurse -Force .\pi\agent\extensions\review "$HOME\.pi\agent\extensions"
Copy-Item -Recurse -Force .\pi\agent\skills\conductor "$HOME\.pi\agent\skills\conductor"
Copy-Item -Recurse -Force .\pi\agent\skills\execute-and-review "$HOME\.pi\agent\skills\execute-and-review"
Copy-Item -Recurse -Force .\pi\agent\skills\design "$HOME\.pi\agent\skills\design"
Copy-Item -Recurse -Force .\pi\agent\skills\executor "$HOME\.pi\agent\skills\executor"
# If previously installed, remove the retired TDD skill:
Remove-Item -Recurse -Force "$HOME\.pi\agent\skills\tdd" -ErrorAction SilentlyContinue
```

If Pi already uses this dotfiles directory as its agent home, no copy is
necessary. When upgrading a copy-based installation, stop Pi and replace the old
`extensions/conductor` copy with the directories above before restarting.
Retained receipts from the old layout remain valid in the same Pi agent home.
Keep the Conductor directory alongside this one so inherited test plans can
resolve the legacy evaluator entry point.

Install `conductor` on PATH (the dotfiles Windows installer already handles
it), or set `CONDUCTOR_BIN` to its executable path. Install `executor` and
`review-cli` separately on PATH, or set `EXECUTOR_BIN` and `REVIEW_CLI_BIN`.
The Windows installers provision all three; use `-Force` to upgrade existing binaries.
Conductor must support v2 with retained-output/output_directory support;
v1 runner responses are rejected without fallback. Pi loads `/skill:design` when implementation is requested, or you can
invoke it explicitly for the full collaborative design-first persona. It
uses `/skill:executor` to author exact operations and the native
`execute_and_review` tool to apply them under retained overall feature authority.
`/skill:execute-and-review` covers task delivery and recovery.
`/skill:conductor` covers the standalone runner protocol. The legacy
`/skill:tdd` direct-edit workflow has been retired; TDD remains an optional
implementation strategy within Design.

Pi skills do not pin a model or establish a separate agent.
The active Pi model executes the Design persona in the current conversation.

## Caller-selected task verification

`execute_and_review` takes an ordered `checks` list defining the verification
commands for an issue.  For example (Cargo filters are illustrative; choose
actual crate and test names for the project):

```json
{
  "checks": [
    { "name": "compile", "command": ["cargo", "check", "--all-targets"] },
    { "name": "invoice unit tests", "command": ["cargo", "test", "--lib", "invoices::"] },
    { "name": "client unit tests", "command": ["cargo", "test", "--lib", "clients::"] }
  ]
}
```

On the first attempt, supply `checks` alongside `input`, `requirements`,
`baseRef`, task/review settings and the required native
`checkpoint: {defaultBranch, protectedBranches}` metadata.

Continuations may omit `checks` to inherit the retained verification plan.
Explicitly supplied plans remain subject to the existing correction and
verification-repair rules.  No build or test commands are added automatically.

The list required 1-64 checks with unique nonblank names, no surrounding
whitespace and at most 256 characters per name.  Each check contains `name`,
an executable/argv `command` array, and an optional executable/argv
`successCondition` array.  Commands run sequentially from the repository root
through Conductor.  Per-check timeout options are not supported.

Choose verification during task design and include the commands and their scope
within the approved feature direction. Use focused tests for task changes and broader regression
checks for the final `validate_feature` gate. Inspect output to confirm relevant
tests actually ran; an exit code of zero can also mean the filter selected no tests.
The existing overall workflow deadline and independent review budgets still apply.

Task receipts retain the exact caller inputs and translated request. Corrections
must preserve the normalized ordered names and commands, including test filters;
changing verification scope requires reconciliation within the approved direction rather than
weakening the existing attempt. The pre-review source/index snapshot is captured
after the **last** requested command succeeds, even if that check is not a test.
All requested check results must appear in order, exactly once, and satisfy
their configured success rules.  Without a successCondition, command exit code
zero is required.  WHen a successCondition is supplied, its sucessful evaluation
is required.  An APPROVED independent review is also required before task evidence can justify a
checkpoint.  `validate_feature` keeps its existing full-project verification interface.

After updating, copy the entire extension directory (including `verification.mjs`)
and restart Pi. Upgrade the installed Conductor binary for the v2 command API.
This version requires Conductor with `success_condition` support (PR #8 or later).

Run `node --test tests/pi-verification.test.mjs tests/pi-conductor.test.mjs tests/pi-task-workflow.test.mjs tests/pi-checkpoint.test.mjs`.

## Conductor v2 command and result translation

Pi supplies `input` (exact Executor JSON), `requirements`, `baseRef`, caller-selected
`checks`, and optional review budgets to the **native tool**, not a handwritten
Conductor request. Conceptually the adapter prepares these stage specifications (not a separate runner invocation):

Each named check may also supply `successCondition: [program, ...args]`. Conductor
runs it after the check, with the original exit code and complete output paths in
`CONDUCTOR_COMMAND_EXIT_CODE`, `CONDUCTOR_COMMAND_STDOUT_PATH`, and
`CONDUCTOR_COMMAND_STDERR_PATH`. Its exit 0 permits the next command, including
when the original exit was nonzero. Use this only for a known tool-specific
contract; Cargo build/test exit status is normally sufficient. The last check's
source/index boundary is captured before its condition is evaluated. Pi retains
the condition decision in its command-prefix evidence before an automatic commit.
Review always has a condition that validates complete `review.result/v1` output
and requires `APPROVED` with no blocking findings before the commit entry runs.

```json
[
  {"name": "executor", "program": "executor", "args": ["apply", "/repo/.git/pi-conductor-runs/attempt-unique/executor.json"]},
  {"name": "invoice tests", "program": "cargo", "args": ["test", "--lib", "invoices::"]},
  {"name": "review", "program": "review-cli", "args": ["run", "--request", "/repo/.git/pi-conductor-runs/attempt-unique/review.json", "--format", "json", "--model", "opencode/gpt-6.1-sol", "--wall-clock-budget-secs", "180", "--max-turns", "20", "--ledger", "/repo/.git/pi-conductor-runs/attempt-unique/review-ledger.jsonl"]}
]
```

The actual Executor and Review entries run through `input-guard.mjs` using Node.
Their arguments bind SHA-256 identities of `executor.json`, `review.json`, and
`requirements.md`. The guard checks the files immediately before and after the
external tool runs and fails the command if any input changed. The stage receipt
retains that exact guarded invocation, and authenticated task evidence verifies
its input identities against the originally retained values.

The paths illustrate a normal repository; linked worktrees use `git rev-parse
--git-path` to resolve their metadata. `executor.json` contains the exact operations
array. `review.json` uses `review.request/v1`, the same repository and fixed full
base SHA, `head_ref: ":working"`, and `requirements` pointing to a UTF-8 file of
**complete original requirements**. Provider/model/budget settings are CLI flags,
not fields in that Review request. Defaults are 180 review seconds and 20 turns;
explicit `review*` overrides are forwarded. Review's own defaults govern omitted
extra limits. These defaults are caller policy, not Conductor's old scaled budgets.

For task-bound attempts the last selected check runs through `test-boundary.mjs`,
which preserves that command's stdout/stderr and exit status and records the
source/index snapshot immediately before Review. The adapter wraps each stage to
retain its actual exit status, then appends the verified Git commit command to
**the same Conductor command list**. Normal delivery uses exactly one runner invocation.

### Automatic post-review commit

The native `execute_and_review` tool now includes local task finalization. Supply:

```json
"checkpoint": {"defaultBranch": "main", "protectedBranches": []}
```

Use the actual default and all additional known protected branches. The feature's
approved branch and original baseline come from Scaffold, not newly guessed values.
Missing metadata or a protected target blocks before source application.

The final commit is part of the **original** `conductor.request/v2`, not a
post-success callback or a second automatic request. An actual wire request looks
like this (paths are illustrative):

```json
{
  "schema": "conductor.request/v2",
  "working_directory": "/repo",
  "output_directory": "/repo/.git/pi-conductor-runs/attempt-unique",
  "commands": [
    {"name": "executor", "program": "/path/to/node", "args": ["/extension/command-stage.mjs", "/repo/.git/pi-conductor-runs/attempt-unique/0.stage.json"]},
    {"name": "invoice tests", "program": "/path/to/node", "args": ["/extension/command-stage.mjs", "/repo/.git/pi-conductor-runs/attempt-unique/1.stage.json"]},
    {"name": "review", "program": "/path/to/node", "args": ["/extension/command-stage.mjs", "/repo/.git/pi-conductor-runs/attempt-unique/2.stage.json"]},
    {"name": "git commit verified task", "program": "/path/to/node", "args": ["/extension/commit-task.mjs", "/repo/.git/pi-conductor-runs/attempt-unique/delivery.json"]}
  ]
}
```

Each stage descriptor contains the exact underlying executable/argv above.
`command-stage.mjs` runs that program with inherited stdout/stderr and retains its
actual process status before returning the same success/failure to Conductor.
Conductor alone advances through the list, so an earlier failure skips commit.
The final command additionally parses complete Executor/Review JSON and checks the
pre-review source/index boundary before any task completion or Git commit.

The enclosing runner has not returned when commit starts. Therefore the final
command seals a caller-owned `pi.command-results/v1` verification prefix from the
actual `pi.command-receipt/v1` records; it never fabricates a completed Conductor
response. The content-addressed task receipt marks its producer as
`pi.command-receipts/v1`, retains exact stage/input identities and the full delivery
request, and authenticates the reviewed source/baseline. The actual complete v2
runner response is retained separately in the attempt's `response.json` after the
one invocation finishes. Historical direct v2/v1 task receipts remain readable.

The final command reauthenticates retained feature authority, latest task evidence,
current issue design and checkpoint lineage, records matching Scaffold completion,
then uses the existing private-index/commit-tree/update-ref checkpoint logic to
commit the exact reviewed tree. No model decision, extra confirmation, indiscriminate
staging or hooks occur between review and commit. The workflow deadline applies
to the single list. A commit-only Conductor request is used **only for explicit
recovery** with `checkpoint_verified_task`, never for normal automatic delivery.

On success the native result has `stage: COMMITTED`, checkpoint provenance and
`nextBaseRef` for the next issue. Completion/checkpoint state is already recorded;
the agent must not repeat those operations. Failed implementation/check/review
never enters this stage. A failed commit returns BLOCKED with
`implementationStatus: PASSED`, the original evidence and finalization log path.
Do not replay source operations. Recover using `checkpoint_verified_task` and the
same receipt/scope; it resumes completion or commits as needed, including recovery
of a commit whose response was lost. Successful implementation receipts remain
immutable and continue to describe the pre-commit reviewed baseline.

Sealing and terminal failure recording share an exclusive per-attempt claim. If
an interrupted command still owns that claim, the result is BLOCKED with
`TERMINAL_RECEIPT_PENDING`; no competing success/failure receipt is invented.
Inspect the latest evidence and Git state before recovery. A STARTED receipt
never authorizes a commit or replaying the list.

The lower-level `executeAndReview` library still performs verification only for
existing integrations/tests. Automatic completion/commit is the native Pi delivery
entry point.

Conductor returns generic `conductor.result/v2`: exits 0/1/2 mean
PASSED/FAILED/BLOCKED. The adapter validates every returned command's index,
program, literal arguments and order, the stop location and the runner exit code.
It reads **complete** Executor and Review stdout from retained files, not truncated
previews. Inline output is accepted only when explicitly untruncated; this does
not make binaries lacking the request output_directory field compatible. Missing, unsafe, malformed or contradictory tool output blocks the
attempt. Structured tool JSON has a 16 MiB parser limit; complete logs remain on
disk for inspection if it is exceeded. Check diagnostics stay in their files.

The adapter projects results to `pi.conductor-result/v1` inside the existing
native tool result; this is a caller-owned domain view, not a Conductor wire schema:

| Tool outcome | Pi outcome |
| --- | --- |
| Executor succeeds, all requested checks exit 0, Review completes APPROVED/exit 0 | PASSED |
| Executor reports unsuccessful application, or a check exits nonzero | NEEDS_DESIGN |
| Review completes CHANGES_REQUESTED/exit 1 with blocking findings | NEEDS_DESIGN |
| Review INDETERMINATE/exit 3, setup/provider errors, signals, runner/protocol errors | BLOCKED |

The normalized verification view retains effective Executor/check/Review specifications,
complete parsed tool output and authenticated process receipts. Content-addressed
task receipts retain that prefix plus exact request-file contents, original args,
source boundary and the full single-list delivery request. The enclosing raw
Conductor request/response stays available in the attempt directory. Checkpoint
authentication reconstructs and cross-checks it without depending on mutable log
files still being present. Historical successful v1 receipts remain readable;
active calls never accept a v1 runner as a successful new attempt.

Requests, full logs and Review ledgers remain in Git metadata alongside receipts,
outside review diffs. Keep them while referenced by active tasks; do not delete an
attempt directory just because its preview was returned. The model-facing native
response omits raw request/output dumps and excerpts long findings; use
`inspect_conductor_evidence` and returned stdout/stderr paths for complete detail.
The runs and receipts are local data and are not transferred by Git push/clone.

## Current limits

- Pi's Docker launcher currently mounts only selected extensions and the
  images do not ship Conductor. Native Pi is supported here; Docker needs
  a separate binary provisioning decision.
- Conductor does not yet prove tests executed or detect unexpected source
  modifications during verification. The adapter imposes a 30-minute overall
  workflow deadline by default, covering execution, formatting, checks and
  independent review; it is not a per-check deadline. Callers may override it
  per invocation with `workflowTimeoutMs` (positive safe integer, maximum
  2147483647 ms, about 24.8 days). This overall deadline is independent of
  `reviewWallClockBudgetSecs` and the other review-specific budgets. Expiration
  blocks the attempt and does not authenticate tests or review. The adapter
  kills the direct Conductor child but does not explicitly terminate or await
  descendant processes.

## Task receipts and checkpoint preflight

Copy `evidence.mjs` with the rest of this directory. Optional `task` binding
(`featureId`, `taskId`, `designRef`) enables repository-local content-addressed
receipts and an initial clean-tree preflight, excluding `.scaffold` bookkeeping.
Legacy unbound calls retain their protocol behavior. Task-bound corrections use
`previousAttempt` and must match the recorded task, requirements, commands,
baseline and tree. No task selection, lifecycle mutation or automatic retry is
implemented here. Pi retains approval and repeated-failure decisions.

Failed/blocked runs retain their actual post-execution source/index fingerprint.
Use `inspect_issue_attempt` and pass its `continuation` fields with newly authored
current-state operations. Already-applied edits need no identity operations;
`{"operations":[]}` reruns verification/Review without replaying source edits.
The original baseRef stays fixed so Review sees the complete cumulative diff.
Never reset source, remove receipts/private refs, or checkpoint unverified work to
recover. `retry`/`start` lifecycle transitions do not reset consumed attempts.

For an incorrect command invocation, supply `verificationRepairReason` (nonblank,
at most 4000 characters) with `previousAttempt` and the repaired commands. Preserve
the check names/order, all success conditions and the approved coverage contract.
Preflight and correction-chain authentication enforce the same rule. The reason,
prior receipt reference and current plan are appended to independent Review's
requirements without changing the fixed task requirements. Old and new commands
remain in linked receipts; all invalidated checks and Review run again; unchanged checks can be reused only
with the explicit measured-environment declaration described in RECOVERY.md. This allows a missing
`sh` command to be replaced with an equivalent native invocation, not a failing
test to be bypassed. Semantic coverage remains a Pi/Review responsibility; a reason
alone is not proof of equivalence. Contract or validator changes require Design
recovery. For a malformed evaluator on a recognized test runner, use the
`repair_check` update with `useMeaningfulTestEvaluator: true` after the approved
redesign and authenticated resume. See [the recovery guide](RECOVERY.md).
Ordinary corrections preserve check identities and coverage; structured revisions are audited.

BLOCKED stops that command list. Pi diagnoses the result and continues recoverable,
in-scope corrections under the existing feature authorization, subject to the same
persisted infrastructure/resource pauses and evidence-backed stall detection. Unavailable credentials/prerequisites or
unrelated source/index drift remain concrete blockers. Prefer executable/argv
commands; inspect the platform before using shell syntax. Native Windows does not
imply `sh` is installed. Use an available native shell only when necessary.

An execution `resume_issue.handoffRef` remains valid through `scaffold_tasks start`.
It is separate from the read-only `prepare_issue_handoff` capsule, whose graph digest
and task_revision intentionally become stale after lifecycle mutations. Refresh
that capsule and continue with the same execution receipt. Never weaken context
staleness checks or use context references as execution evidence.

`inspect_conductor_evidence` reads a receipt by its returned
`pi-evidence:sha256:<digest>` reference and reports whether the current tree
matches. Records are under Git metadata, outside review diffs. STARTED intent is
written before execution; final records retain the request, raw process response,
result, task/design identity, attempt number and tree fingerprints. Missing or
corrupt records cannot justify completion. Retention failures block completion;
source may already have changed, so reconcile before proceeding. Initial intent
write failure prevents invocation. Hashes detect corruption, not hostile local
rewriting. Fingerprints cover index/diff and nonignored untracked regular files;
ignored build outputs and Scaffold state are outside the fingerprint. Git's diff
output limit is 16 MiB; fingerprint failures block rather than weakening evidence.

### Check evidence in independent review

The task pipeline keeps full logs, requests, and content-addressed receipts in
the existing worktree-specific Git metadata paths. It passes a bounded evidence
summary through Review CLI's requirements-file input. Review CLI loads this
input before starting the model, so the reviewer receives the evidence with the
task criteria and uses its existing tools to inspect code. It needs no additional
repository-tool access. Moving all artifacts to an ignored working-tree directory
would expose raw diagnostics to working-tree reads and would not serve a review
of a committed tree.

The summary identifies the attempt intent receipt, reviewed tree and index
fingerprint, check command, exit code, validator outcome, receipt and log digests,
and recognizable test counts from bounded log excerpts. Each check must start
and finish on the reviewed snapshot. Conductor checks the receipt/validator pair
before invoking Review, guards the generated inputs during invocation, and
reconstructs the handoff from the sealed result during checkpoint authentication.
The existing receipt references and older authenticated receipts remain valid.

A matching current pass gives Review evidence to resolve an earlier failed-check
obligation by ID. Review still assesses each open obligation and can reject an
inequivalent repair or a separate code finding. The task handoff covers targeted
verification. Final feature validation uses the authenticated checkpoint to
carry that resolution forward while running its separate full-project checks
and cumulative review.

Raw logs and private Git paths stay local. Only recognizable test counts are
extracted from new task log output for review. Check names and command arguments
are visible to Review, so use credential injection through the process environment
and keep secrets out of commands, requirements and check names. The generated
requirements and request files use the existing private attempt directory and
follow its retention lifecycle. Preserve that directory if a receipt still
depends on its logs for reuse, or if the original review input must remain
available for audit.

Keep receipts as long as Scaffold references them; preserve separately when moving
a checkout because Git push/clone does not transfer them. Never claim that a
structural PASSED check proves meaningful tests ran: inspect actual output.

Run `node --test tests/pi-task-workflow.test.mjs tests/pi-conductor.test.mjs`.
For the dependent-task/recursive-recovery scenario with real Scaffold, set
`SCAFFOLD_SOURCE=/path/to/scaffold`. Conductor/model responses are fixture data.

Before task execution, `.scaffold/` bookkeeping must be ignored and untracked so
it cannot enter Conductor's review diff. Inspect existing ignore rules. If state
is visible to Git, stop and have an authorised ignore rule established; do not
silently edit `.gitignore`, Git configuration or index. The task-bound preflight
returns `SCAFFOLD_REVIEW_SCOPE` for visible state. A source ignore-file change,
if needed, follows its own feature-authorized verification and checkpoint workflow.

## Feature validation

`validate_feature` is a native verification-only gate requiring Phase 5 Scaffold.
The final gate continues to use its bounded native command runner plus the
existing Review adapter. It does not fabricate an implementation task or change
its meaningful-test checks, cumulative scope, or evidence protocol. Task checkpoint authentication is shared with the
checkpoint tool. Model-facing Scaffold operations cannot submit feature outcomes.

See Design's final feature verification section for input fields, literal output
markers, retained feature authority, result/evidence contracts and recovery. The gate
records intent, checks, cumulative Review and final result in content-addressed
Git metadata. The CLI lifecycle pins the original baseline, validates all-task
completion and preserves attempts. Applicability is computed against actual Git
and task state, not the historical Scaffold status alone.

Run the integration suite against the companion Scaffold checkout:

```sh
SCAFFOLD_SOURCE=/path/to/scaffold node --test tests/pi-feature-validation.test.mjs tests/pi-checkpoint.test.mjs
```

No live AI calls are needed; temporary Git repositories, real Scaffold processes
and deterministic Review CLI fixtures exercise failures, corrective checkpoints,
full cumulative reviews and idempotent interruption recovery.

## Continue development after rebasing

A completed rebase changes checkpoint parents and usually trees. Historical task
receipts remain valid for the old history; they cannot verify conflict resolutions
or rewritten trees. Do not edit their SHAs, checkpoint trailers, approved design,
Scaffold completion records or original `featureBaseRef` to force a match.

Use `reconcile_feature_rebase` **between tasks**, after all started tasks have
finished and been checkpointed. The user performs the separately authorized Git
rebase; this tool never rebases or edits source. Capture the old feature HEAD
before rebasing (or recover and inspect it from the reflog), and preserve empty
checkpoints/task ordering, for example with Git's `--empty=keep` option. Squashed,
dropped, reordered, extra or merged commits are rejected; a task already present
upstream still needs its checkpoint preserved, using `--reapply-cherry-picks`
when appropriate. Finish conflict resolution before requesting reconciliation.

Inputs extend `validate_feature`'s explicit full-project build/test commands,
literal success markers, integration checks and bounded Review settings with:

- `featureBaseRef`: the immutable **original** feature-start full SHA.
- `oldHeadRef`: the last checkpointed HEAD before this rebase.
- `upstreamBaseRef`: the new upstream full SHA onto which the feature was rebased.
- `headRef`, `branch`, `featureId`, `designRef`: the actual rebased feature identity.
- `defaultBranch`, `protectedBranches`: known branch protection scope, as for checkpoints.
- `previousReconciliationRef`: the preceding successful receipt for a second or later rebase.

The tool requires clean HEAD/index/worktree, ignored/untracked Scaffold, no active
Git operation, and no in-progress, failed or blocked task loop. It authenticates
all completed old checkpoints and receipt chains, matches their task identities
and ordering to the rebased commits, and requires the new upstream to descend
from the preceding baseline. Fresh meaningful checks and independent Review of
the completed prefix against `upstreamBaseRef` must pass before it returns PASSED.
Pending feature criteria remain deferred, while original design/constraints and
completed tasks' retained requirements are supplied to Review.

Retain the returned `evidenceRef` and pass it as `reconciliationRef` to **every
subsequent** `checkpoint_verified_task` and `validate_feature` call. Capture the
rebased HEAD as the next task's new `baseRef`; its correction-loop baseline still
cannot change. The checkpoint scope includes this authenticated reconciliation. The overall
feature grant remains bound to the original direction, branch and baseline. Final feature
validation still reviews from the immutable original feature baseline, satisfying
Scaffold's existing lifecycle contract, and additionally authenticates the rebase
receipt and all subsequent checkpoints. No Scaffold or Rust Conductor update is
required. No task is automatically selected, retried or marked complete.

`inspect_rebase_reconciliation` discovers receipts with `featureId` or reads a
specific `reference`, reporting applicability against actual Git and Scaffold.
Evidence uses the existing content-addressed `pi-feature-evidence:sha256:...`
namespace with `kind: reconciliation` and a `pi.feature-reconciliation/v1` outcome;
feature-validation inspection excludes it. Intents and failures never authorize
continuation. If success was retained before interruption, call reconciliation
with the exact original inputs/plan plus `resumeEvidenceRef`; this authenticates
and returns the success without rerunning checks or requesting execution authority.
Changed plans/revisions require fresh verification.

Evidence and both sides of Git history are retained locally, using audit refs
under `refs/pi-reconciliations/<receipt-hash>/{before,after}` to survive Git garbage
collection. Ordinary pushes/clones do not transfer this local evidence. Preserve
it with the checkout. Hashes detect corruption, not hostile local rewriting.
Rebases during an active task remain blocked: explicitly stop/recover that loop
first, without resetting work or treating unverified edits as a fresh baseline.

## Rebase after a task has already started

Use `recover_interrupted_task_rebase` for an existing `in_progress`, `blocked` or
`failed` task whose baseline was rewritten while its uncommitted work remains.
This is the explicit interrupted-loop recovery referenced above; the ordinary
between-task tool keeps its clean-tree restrictions. Never stash/reset the source
checkout, rename the task, edit receipts or reset its consumed attempts to make
that tool accept the state.

Pass the same feature/rebase/branch/protection fields and completed-prefix
verification plan as `reconcile_feature_rebase`, plus:

- `task: {featureId, taskId, designRef}`: the original interrupted task identity.
- `previousAttempt`: its latest real retained receipt, linking every earlier attempt.
- `oldHeadRef`: that task's original fixed `baseRef`, not a new or inferred baseline.
- `previousReconciliationRef`: the preceding feature rebase receipt for a later rebase.

The retained overall feature authority covers both completed-prefix verification and the
baseline handoff. Recovery authenticates the entire receipt chain and consumed
attempt count, and uses Git object-only three-way merging to prove the current
implementation tree equals the retained task tree transplanted onto rebased HEAD.
It never applies that merge to the source checkout. Conflicts, extra/missing edits,
missing receipts/objects, divergent staged variants and stale execution history block recovery rather than guessing. A clean index at HEAD or an index
containing the entire current task tree is supported; other staged variants need
explicit reconciliation. Git must support `merge-tree --write-tree --merge-base`.

Completed-prefix commands and independent review run in a disposable detached
worktree at rebased HEAD, without the interrupted task's source files. Both that
worktree and the real source checkout are checked for concurrent changes. The
real working tree, index, branch and Scaffold status stay unchanged. Select
checks appropriate to the completed prefix; pending task-specific tests may not
exist there yet. No dependency install or source repair is run automatically.

A successful result is **READY**, never task PASSED. It returns:

- `handoffRef`: a content-addressed task receipt with `kind: rebase-handoff`.
- `reconciliationRef`: successful fresh evidence for the completed prefix.
- `consumedAttempts` / `remainingAttempts`: unchanged task-wide budget.
- `resume`: fixed original task/check settings, new `baseRef`, additive original
  criteria/retained findings, and `previousAttempt: handoffRef`. It intentionally
  omits `input`, so old source operations cannot be blindly replayed.

For example, three consumed attempts remain three; the next Conductor invocation
is attempt four and at most two attempts remain. The handoff links the old three
receipts unchanged, retains all original requests/responses and diagnostics, and
retains unresolved review findings and prior context revisions. Ordinary retries
inherit them automatically; structured repairs and added checks preserve coverage.
Later rebases preserve the same invocation history.

Inspect the handoff through `inspect_task_rebase_recovery` or
`inspect_conductor_evidence`. If the task is blocked/failed, explicitly reconcile
its Scaffold lifecycle with `retry` and `start`, recording the handoff reference
and consumed count in the reason; recovery does not do this automatically.
Author the actual correction from current source, stay within the retained feature authority, then call `execute_and_review` with `resume` plus new exact `input`.
Only a real subsequent successful Conductor attempt can complete the task. Pass
`reconciliationRef` to its checkpoint and final feature validation as usual.

On interruption, `prefixEvidenceRef` reuses an authentic complete matching prefix
result; `resumeHandoffRef` recovers an already retained matching handoff without
running checks again. Changed source/state/plan must not reuse old authorization.
Read-only inspection reports applicability; historical READY is not task approval.
Git audit refs under `refs/pi-task-recoveries/<receipt-hash>/` preserve every old
and recovered snapshot against garbage collection; interrupted audit-ref writes
are idempotently repaired without replacing unexpected existing refs. Keep all
local evidence with the checkout. A killed process can leave a temporary worktree;
inspect ownership before removing it, never clean the real source checkout.


## Recursive issues: design then implement

All Scaffold features use the recursive issue graph (requires the matching
Scaffold release). There is no opt-in field or alternate lifecycle. The stored
workflow kind is `recursive-issues/v1`; the state schema is version 2. The root is created from the agreed
ticket. Pi uses `design-next`, `decompose` and `design-record` to approve designs
downward; `design-finish` gates all implementation. The API retains task IDs.
`execute_and_review` requires an explicit started issue. For a first attempt (or a
zero-attempt recovery handoff), the adapter adds the persisted acceptance criteria,
constraints and exact approved design to caller-supplied additional `requirements`
(which may be empty). Existing callers supplying the complete canonical text remain
supported. The assembled scope goes to Review and the retained receipt. Corrections
supply previousAttempt and fresh operations; the native adapter inherits the contract,
checks and authority. Structured contextUpdates retain discoveries and revisions.
Use `issueHandoffRef` instead of `previousAttempt` to continue directly from a
saved, applicable `prepare_issue_handoff` result. The adapter reauthenticates the
handoff and resolves its latest receipt before running the normal continuation
checks. If continuation reports a stale handoff or receipt, use the returned
`prepare_issue_handoff` recovery action to refresh the context, then inspect the
latest attempt before authoring corrections.
No caller transcription of inherited requirements or approval prose is needed.
Branch mismatches report current/expected branches, while malformed or stale
`task.designRef` values report the expected feature reference. These precheck errors
do not consume an execution attempt and do not require reapproval. Unbound execution cannot
bypass an unfinished recursive feature. Older task-state files are rejected without modification.

`checkpoint_verified_task` records its verified commit back into Scaffold. Retry
that native operation after interrupted bookkeeping; never fabricate a checkpoint
record. Empty parent verification still creates its own commit. Final verification
includes the original ticket and retained issue design contracts.

`suspend_issue` explicitly parks unfinished work for newly discovered issues.
Inputs: task binding, latest `previousAttempt`, reason, original featureBaseRef,
branch/default/protected scope and optional reconciliationRef. Retained feature authority covers
saved snapshots/index refs and a retained stash including untracked source; it
never publishes, completes an issue or resets attempts. A content-addressed intent
is retained first and returned as suspensionRef, including on failure. Retry that
same intent with suspensionRef and exact reason/scope; inspect source and stash
state first. Saved stashes/private refs are deliberately never automatically removed.
The original source must match the latest unsuccessful receipt and remaining budget.

After new children are designed, implemented and checkpointed, `resume_issue`
requires the same scope and suspensionRef. It authenticates checkpoint lineage,
precomputes source/index transplants to reject conflicts before source writes,
restores saved work with `git stash apply --index`, and retains a non-PASSED
`issue-handoff`. READY supplies consumedAttempts and resume arguments without old
executor input. Start the original issue and continue within the approved feature direction.
Use the returned handoff as previousAttempt; three attempts mean four next. A
handoffRef recovers interrupted evidence/Scaffold bookkeeping. Read snapshots and
receipts with inspect_conductor_evidence. Conflicts or unexpected changes block;
preserve saved refs/stash and reconcile explicitly. Ignore files/generated ignored
artifacts are outside snapshot coverage. A user-performed rebase still requires
the separate authenticated rebase-reconciliation path before prerequisite checkpoints.


### Issue recovery boundaries

A started issue with no retained attempt may return to Design through
`suspend_issue` without `previousAttempt`. This path requires a clean source/index
and confirms that no attempt receipt exists; it consumes zero attempts. Resume
returns an authenticated zero-attempt handoff. Supply fresh approved requirements,
checks and executor input for its first real execution; that execution is attempt 1.
Dirty unretained changes or any existing consumed attempt require normal receipt
reconciliation rather than this path. No dummy Conductor invocation is needed.

An issue may remain suspended while the user rebases its completed prerequisites.
Pass the current successful `reconciliationRef` to resume. It must authenticate as
a successor of the saved reconciliation and include the suspension's checkpoint
history. The continuation records this successor; unrelated anchors are rejected.

Pending checkpoint recovery pins the original staged subset atomically with the
checkpoint commit. A retry accepts that exact original index or an already finalized
verified index; another staged subset remains blocked. The private pending index
ref is removed after successful finalization.


## Scoped issue context

Scaffold `summary`, `issue --task`, `select` and `design-select` return bounded-by-scope
projections rather than the full feature/history. The Pi Scaffold tool uses scoped
selection and compact acknowledgements by default; explicit list remains available.
Native execution/checkpoint/recovery validation still reads complete state.

`prepare_issue_handoff` persists a content-addressed capsule in the repository's
Git metadata (`pi-issue-context`), containing scoped contracts, current Git fingerprint,
latest authenticated attempt/findings excerpt and bounded agent navigation notes.
`inspect_issue_handoff` discovers by feature/issue or reads by reference and checks
current graph digest, source/index/HEAD and latest attempt. Stale handoffs return
only diagnostics and refresh instructions. `inspect_issue_attempt` loads exact fixed
continuation requirements/checks by receipt reference without executor input or raw
logs. None of these tools executes source, changes lifecycle state, grants approval,
resets attempts or substitutes summaries for full evidence validation. Handoffs are
local to this checkout; they are not pushed with commits. Large individual contracts
are retained intact rather than silently truncating criteria or decisions.


## One overall feature direction approval

Pi's native entry points now use `approve_feature_direction` as the sole user
confirmation for local delivery. Present the direction, initialize its feature,
then call this tool without a separate conversational yes/no. It stores a
content-addressed feature authorization binding repository, feature/design,
branch, original baseline, objective, criteria, constraints and local capabilities.
An existing matching grant is reused across sessions; missing UI, declined approval,
changed scope or corrupted evidence cannot grant permission. Existing features need
this broader approval once; individual issue approvals do not imply it.

Within scope Pi designs issues, authors input, implements, verifies, creates local
verified checkpoints and handles discoveries without asking again. The design-record
`approval` field identifies delegated authority and the actual reference; it must
not invent individual user approval. Execution, checkpoint, feature verification,
issue recovery and rebase verification native gates consult the same authority.
Phase, receipt, Git, attempt-budget and final-review checks remain enforced.
Approval receipts are excluded from final-validation evidence discovery and never
prove success. Final independent feature review and meaningful checks are mandatory;
in-scope findings return through the graph automatically. Material departures from
approved objectives, public behaviour or constraints require revised overall direction.
The grant does not authorize publishing, merging or arbitrary history rewriting.

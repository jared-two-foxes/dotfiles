> Current Pi continuation API: see [RECOVERY.md](RECOVERY.md). Continuations inherit
> context from receipts and Scaffold; no exact requirements-string copy or lifetime
> attempt allowance is required.

# Pi delivery extension

`index.ts` registers `execute_and_review` and delivery inspection and approval tools.
The workflow in `delivery.mjs`, `adapter.mjs`, and `pipeline.mjs` owns task
binding, continuation, and one execution/check/review pass. `workflow.mjs`
prepares Executor and Review inputs. Shared verification authenticates their results.

The workflow uses the sibling [Conductor client](../conductor/README.md) to run
the plan. The Executor and [Review](../review/README.md) clients describe their
CLI invocations and validate their results. Execute and Review assembles those
steps and consumes shared authorization, evidence, and verification contracts.

The sibling `execution-recovery` extension registers handoff, suspension,
restore, and rebase tools and implements commit recovery. The `checkpoint`
extension owns task completion and Git checkpoint creation and registers
`checkpoint_verified_task`. `feature-validation` registers the final feature
gate and its evidence inspection tool.

Shared modules have narrower responsibilities.

| Library | Responsibility |
|---|---|
| `lib/scaffold` | Issue and feature types and structural request/response validation |
| `lib/verification` | Check plans, meaningful results, review evidence, attempt chains, and checkpoint history |
| `lib/evidence` | Immutable receipt retention, lookup, and reference integrity |
| `lib/git` | Source snapshots, tree/index operations, and tracked-input monitoring |
| `lib/authorization` | Feature approval and amendment authentication using supplied structures |
| `lib/delivery-state` | Context transformations, journal anchors, bindings, and retained handoffs |

The Scaffold extension owns CLI invocation and state reads. Execute and Review,
Recovery, and Checkpoint supply fresh Scaffold data to the shared validators and
own lifecycle writes. See [the library boundaries](../../lib/README.md).
Plans and retained workflows require guards and evaluators from `lib/verification`.
Obsolete helper identities and receipt producers are rejected, without rewriting retained evidence.

## Native Pi installation

Copy `pi/agent/lib/` into the Pi agent home's `lib/` directory. It contains
shared contracts and the Conductor, Executor, and Review CLI integrations.
Install the Pi entry points under `extensions/`.

```
~/.pi/agent/extensions/conductor/
~/.pi/agent/lib/
~/.pi/agent/lib/delivery-state/
~/.pi/agent/extensions/execute-and-review/
~/.pi/agent/extensions/execution-recovery/
~/.pi/agent/extensions/checkpoint/
~/.pi/agent/extensions/feature-validation/
~/.pi/agent/extensions/review/
~/.pi/agent/extensions/scaffold/
```

For a dotfiles checkout on Windows, a copy-based installation is:

```powershell
Copy-Item -Recurse -Force .\pi\agent\extensions\conductor "$HOME\.pi\agent\extensions"
New-Item -ItemType Directory -Force "$HOME\.pi\agent\lib" | Out-Null
Copy-Item -Recurse -Force .\pi\agent\lib\* "$HOME\.pi\agent\lib"
Copy-Item -Recurse -Force .\pi\agent\extensions\execute-and-review "$HOME\.pi\agent\extensions"
Copy-Item -Recurse -Force .\pi\agent\extensions\execution-recovery "$HOME\.pi\agent\extensions"
Copy-Item -Recurse -Force .\pi\agent\extensions\checkpoint "$HOME\.pi\agent\extensions"
Copy-Item -Recurse -Force .\pi\agent\extensions\feature-validation "$HOME\.pi\agent\extensions"
Copy-Item -Recurse -Force .\pi\agent\extensions\scaffold "$HOME\.pi\agent\extensions"
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
Replace obsolete installed helper copies as well; old layouts are unsupported.

Install `conductor` on PATH (the dotfiles Windows installer already handles
it), or set `CONDUCTOR_BIN` to its executable path. Install `executor` and
`review-cli` separately on PATH, or set `EXECUTOR_BIN` and `REVIEW_CLI_BIN`.
The Windows installers provision all three; use `-Force` to upgrade existing binaries.
Conductor must support v2 with retained-output/output_directory support;
v1 runner responses are rejected without fallback. Pi loads `/skill:init-feature` for Linear/requirements preparation without implementation,
or `/skill:feature-delivery` when autonomous feature implementation is requested, or you can
invoke it explicitly for the complete approved feature workflow. It
uses `/skill:executor` to author exact operations and the native
`execute_and_review` tool to apply them under retained overall feature authority.
`/skill:implement-task` owns task-scoped implementation, correction and checkpoint recovery; the native `execute_and_review` tool remains one bounded Conductor attempt.
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

A first attempt may not use a bare full-suite check. `lib/verification/check-scope.mjs`
recognizes a plain `cargo test` / `cargo nextest run`, `npm|pnpm|yarn|bun test`, `pytest`
(also `python -m pytest`), `go test ./...`, `dotnet test`, `node --test`, `vitest`, `jest`,
`mocha` and `ava` with nothing narrowing the run, and returns `BROAD_CHECK_UNJUSTIFIED`
before any source operation. A test name, path, package, `--test`/`--lib`, `-k`/`-m`,
`--filter` or similar selector makes a check targeted. When the whole suite is genuinely
required, name the check and say why:

```json
{ "broadCheckJustifications": [
  { "check": "integration", "reason": "The runner cannot select the affected tests individually" }
] }
```

Each reason must be 20-2000 characters and name an existing check (`BROAD_CHECK_JUSTIFICATION_INVALID`
otherwise). The reasons are retained with the receipt's `args`. Continuations and
resumed issues with a retained plan inherit that plan and are not re-checked, so work
in flight is never stranded. This is a guardrail against accidental cost, not a
security boundary: shell-wrapped commands such as `sh -c "cargo test"` are not
inspected, and anything that could be a selector is treated as targeted so that
ambiguity never blocks a legitimate check. It is not applied when the design graph is
finished, because designs are free text owned by Scaffold; the first attempt is where a
structured plan first exists. The final `validate_feature` plan is full-project by design.

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
  {"name": "executor", "program": "executor", "args": ["apply", "/repo/.scaffold/work/runs/attempt-unique/executor.json"]},
  {"name": "invoice tests", "program": "cargo", "args": ["test", "--lib", "invoices::"]},
  {"name": "review", "program": "review-cli", "args": ["run", "--request", "/repo/.scaffold/work/runs/attempt-unique/review.json", "--format", "json", "--model", "opencode/gpt-6.1-sol", "--wall-clock-budget-secs", "180", "--max-turns", "20", "--ledger", "/repo/.scaffold/work/runs/attempt-unique/review-ledger.jsonl"]}
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
  "output_directory": "/repo/.scaffold/work/runs/attempt-unique",
  "commands": [
    {"name": "executor", "program": "/path/to/node", "args": ["/extension/command-stage.mjs", "/repo/.scaffold/work/runs/attempt-unique/0.stage.json"]},
    {"name": "invoice tests", "program": "/path/to/node", "args": ["/extension/command-stage.mjs", "/repo/.scaffold/work/runs/attempt-unique/1.stage.json"]},
    {"name": "review", "program": "/path/to/node", "args": ["/extension/command-stage.mjs", "/repo/.scaffold/work/runs/attempt-unique/2.stage.json"]},
    {"name": "git commit verified task", "program": "/path/to/node", "args": ["/extension/commit-task.mjs", "/repo/.scaffold/work/runs/attempt-unique/delivery.json"]}
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
`pi.command-receipts/v2`, retains exact stage/input identities and the full delivery
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

For an incorrect command invocation, supply a `contextUpdates` entry with
`kind: "repair_check"`, the original `checkId`, repaired `command` argv and a
nonblank `reason` (at most 4000 characters), alongside `previousAttempt`. Preserve
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

The user rebases the feature branch; Pi never does. `rewrite_feature_history` then verifies the rebased result
and records it in the Scaffold ledger. **Rebase between tasks only.** If a task is active, suspend it first
(`suspend_issue`), rewrite, then resume it (`resume_issue`); a resume restores the saved work onto the current head.

The ledger keeps the ordered history from its **base** to its **head**: task checkpoints and user-approved foreign
commits. `original_baseline` is the immutable fork point. `base` is where the *current* history starts: the fork
point until a rewrite moves it onto the commit the branch was rebased onto.

Inputs: `featureId`, `designRef`, `branch`, `oldHeadRef` (the head the ledger records), `upstreamBaseRef` (what the
branch was rebased onto), `headRef` (current HEAD), `defaultBranch`, `protectedBranches`, the same build/test/integration
checks and review settings as `validate_feature`, and optionally `resumeEvidenceRef`.

What it does, in order:

1. Requires a clean feature branch, an approved feature direction, no active task, HEAD equal to `headRef`, and
   `oldHeadRef` equal to the ledger's recorded head. The pre-rebase chain must still match Git (those commits remain in
   the object store until garbage collected).
2. Maps every recorded checkpoint and foreign commit onto the rebased commits, in order, on top of `upstreamBaseRef`.
   A checkpoint is recognized by its `Pi-Checkpoint: <task>` trailer, a foreign commit by its subject. A rebase that
   **drops, squashes, splits, reorders or adds** a recorded commit, or that contains merges, is refused.
3. Runs fresh full-project checks and an independent review of `upstreamBaseRef..HEAD`. Earlier receipts are
   historical and do not verify the rewritten trees.
4. Retains the verification (checks, review, the new history) as a ledger artifact, then records a `history-rewrite`
   entry. The previous history, its base and the verification reference stay in the ledger (`epochs`).

`PASSED` is returned only after the entry is recorded. Any other status records nothing; the evidence of a rejected
review or failed check is retained for diagnosis. A repeat, or a retry after a lost response, returns the same
record without needing a clean tree; pass the retained `evidenceRef` as `resumeEvidenceRef` to record a verification
that passed but whose entry was not recorded. Final validation then binds to the new base.

Commits made after the last recorded head that are not part of a rebase (for example unrelated files the user
committed) are recorded with `adopt_foreign_commits`, not here.

## Recursive issues: design then implement

All Scaffold features use the recursive issue graph (requires the matching
Scaffold release). There is no opt-in field or alternate lifecycle. The stored
workflow kind is `recursive-issues/v1`; the state schema is version 2. The root is created from the agreed
ticket. Pi uses `design-select`, `decompose` and `design-record` to approve designs
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
branch/default/protected scope. Retained feature authority covers
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

A suspended issue stays parked while the user rebases and `rewrite_feature_history` records it. `resume_issue` then
restores the saved work onto the ledger's current head, after checking that Git still matches the recorded history.

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

## Timing telemetry

Delivery records where time goes so speed changes can be justified and verified.
Telemetry is additive and non-authoritative: it is never part of the request,
workflow, result, check or review data that authenticators compare, and it does
not change the digest of any command receipt handed to independent Review.
Receipts written before this existed remain valid and report no timings.

- Each stage wrapper (`command-stage.mjs`) writes `<index>.timing.json` beside its
  receipt with the stage's start time, total `duration_ms` and its parts:
  `snapshot_ms`, `handoff_ms`, `process_ms`, `snapshot_after_ms`, plus `reused`.
  A failure to write it never changes the stage outcome.
- A sealed task receipt gains a top-level `timings` field: per-stage timings,
  `execution_ms`, `checks_ms`, `review_ms`, `seal_prep_ms`, the raw event count
  of the review ledger (`review_ledger_events`) and the attempt number.
- A `validate_feature` receipt gains `timings` with each check's duration,
  `review_ms`, `total_ms` and how often (`precondition_checks`) and how long
  (`precondition_ms`) full preconditions were derived, counting the initial and
  post-authorization derivations as well as the re-checks, up to the last one before
  retention. Failed and interrupted runs keep the timings gathered so far.
- `execute_and_review` reports `telemetry` in the tool `details`: call wall time
  and the Scaffold CLI calls and time it spent. Only Scaffold invocations are
  counted (not the Git repository probe). Scaffold is called from two processes,
  Pi and the commit command Conductor launches, so the figure is their total
  with each part shown; `complete: false` means the commit process's share is
  unknown, as when finalization was blocked. The model-facing text is unchanged.
- `inspect_conductor_evidence` returns `timingSummary`. To list every receipt in a
  checkout: `node pi/agent/extensions/execute-and-review/timing-summary.mjs [repo]`.

## Final-validation precondition cache

`validate_feature` derives its preconditions repeatedly (before and after
authorization, after every check and the review, before and after retention). The
costly part authenticates every completed task: it walks each checkpoint commit,
re-reads and re-verifies each task's evidence and attempt chain, re-authenticates
amendments and scans earlier feature reviews. `lib/verification/precondition-cache.mjs`
reuses that result within one run while nothing it reads has changed.

- **What is reused:** only the immutable authentication. The live checks (no Git
  operation in progress, branch, clean HEAD/index/worktree, the Scaffold state read,
  the active validation attempt) run on every derivation.
- **When it is reused:** the Scaffold feature (excluding `validation`, which only this
  gate writes), the validation arguments and a fingerprint of every evidence file's
  name, size, inode, mtime and ctime must all be unchanged. A file added, removed,
  renamed or edited in place invalidates it. Git objects are immutable by SHA.
- **What is never reused:** failures are never cached. The first derivation and the
  last one before the receipt is retained always recompute in full, so a persistent
  change to any input, including check logs outside the evidence directory, is caught
  before a receipt is written. Cached results are handed out as copies.
- **Observability:** the receipt's `timings.precondition_cache` reports `hits`,
  `misses` (recomputed after a change) and `fresh` (required full recomputes).
  Fingerprinting costs about 5 ms for 50 evidence files, 14 ms for 500 and 47 ms for
  2000, which a reused derivation pays instead of re-authenticating every task.

Not yet available: review model turns and tool calls. `review-cli` does not expose
them in its JSON result and its ledger vocabulary is not interpreted here, so only
the raw ledger event count is kept. Exposing them needs a `review-cli` change.


# Pi Conductor integration

The native Pi extension in `extensions/conductor/` registers
`execute_and_review` and sends a `conductor.request/v1` to the standalone
Rust `conductor` binary. It does not invoke executor or review-cli directly.

## Native Pi installation

Place the entire `conductor` directory (including `adapter.mjs` and
`package.json`) at:

```
~/.pi/agent/extensions/conductor/
```

For a dotfiles checkout on Windows, a copy-based installation is:

```powershell
Copy-Item -Recurse -Force .\pi\agent\extensions\conductor "$HOME\.pi\agent\extensions\conductor"
Copy-Item -Recurse -Force .\pi\agent\skills\conductor "$HOME\.pi\agent\skills\conductor"
Copy-Item -Recurse -Force .\pi\agent\skills\design "$HOME\.pi\agent\skills\design"
Copy-Item -Recurse -Force .\pi\agent\skills\executor "$HOME\.pi\agent\skills\executor"
# If previously installed, remove the retired TDD skill:
Remove-Item -Recurse -Force "$HOME\.pi\agent\skills\tdd" -ErrorAction SilentlyContinue
```

If Pi already uses this dotfiles directory as its agent home, no copy is
necessary. Restart Pi after changing extensions.

Install `conductor` on PATH (the dotfiles Windows installer already handles
it), or set `CONDUCTOR_BIN` to its executable path. Pi loads `/skill:design` when implementation is requested, or you can
invoke it explicitly for the full collaborative design-first persona. It
uses `/skill:executor` to author exact operations and the native
`execute_and_review` tool to apply them after separate execution approval.
`/skill:conductor` is the lower-level execution reference. The legacy
`/skill:tdd` direct-edit workflow has been retired; TDD remains an optional
implementation strategy within Design.

Pi skills do not pin a model or establish a separate OpenCode-style agent.
The active Pi model executes the Design persona in the current conversation.

## Caller-selected task verification

`execute_and_review` accepts an ordered `checks` list instead of requiring a
single build and a single test command. For example (Cargo filters are illustrative;
choose actual crate and test names for the project):

```json
{
  "checks": [
    { "name": "compile", "command": ["cargo", "check", "--all-targets"] },
    { "name": "invoice unit tests", "command": ["cargo", "test", "--lib", "invoices::"] },
    { "name": "client unit tests", "command": ["cargo", "test", "--lib", "clients::"] }
  ]
}
```

Supply this alongside the existing `input`, `requirements`, `baseRef` and optional
task/review settings. Supply **either** `checks` **or** both legacy
`buildCommand`/`testCommand` arrays; mixing them is rejected before invocation.
Legacy calls still become checks named `build` and `test`. No default build or
full test suite is added when `checks` is supplied. The list requires 1–64 checks
with unique nonblank names (no surrounding whitespace, at most 256 characters).
Each command is an executable/argv array, never shell text, and runs sequentially
from the repository root through Conductor. Check objects accept only `name` and
`command`; per-check timeout options are not supported by the Conductor protocol.

Choose verification during task design and include the commands and their scope
in execution approval. Use focused tests for task changes and broader regression
checks for the final `validate_feature` gate. Inspect output to confirm relevant
tests actually ran; an exit code of zero can also mean the filter selected no tests.
The existing overall workflow deadline and independent review budgets still apply.
This interface is a Pi-local addition; the OpenCode adapter retains its legacy inputs.

Task receipts retain the exact caller inputs and translated request. Corrections
must preserve the normalized ordered names and commands, including test filters;
changing verification scope requires reconciliation and fresh approval rather than
weakening the existing attempt. The pre-review source/index snapshot is captured
after the **last** requested command succeeds, even if that check is not a test.
All requested check results must appear in order, exactly once, with zero exits
and an APPROVED independent review before task evidence can justify a checkpoint.
`validate_feature` keeps its existing full-project verification interface.

After updating, copy the entire extension directory (including `verification.mjs`)
and restart Pi. No Conductor binary change is required for named checks.

Run `node --test tests/pi-verification.test.mjs tests/pi-conductor.test.mjs tests/pi-task-workflow.test.mjs tests/pi-checkpoint.test.mjs`.

## Current limits

- Pi's Docker launcher currently mounts only selected extensions and the
  images do not ship Conductor. Native Pi is supported here; Docker needs
  a separate binary provisioning decision.
- The Pi adapter is a local copy of the tested OpenCode protocol adapter,
  because the two agent homes can be installed independently. Keep their
  protocol behavior aligned.
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
if needed, follows its own normal approval and checkpoint workflow.

## Feature validation

`validate_feature` is a native verification-only gate requiring Phase 5 Scaffold.
Conductor's Rust request still always applies Executor operations and formatting,
so validation uses a bounded native command runner plus the existing Review
adapter instead of fabricating an implementation task. No Conductor/Review CLI
protocol changes are required. Task checkpoint authentication is shared with the
checkpoint tool. Model-facing Scaffold operations cannot submit feature outcomes.

See Design's final feature verification section for input fields, literal output
markers, narrow UI authority, result/evidence contracts and recovery. The gate
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

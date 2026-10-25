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

## Current limits

- Pi's Docker launcher currently mounts only selected extensions and the
  images do not ship Conductor. Native Pi is supported here; Docker needs
  a separate binary provisioning decision.
- The Pi adapter is a local copy of the tested OpenCode protocol adapter,
  because the two agent homes can be installed independently. Keep their
  protocol behavior aligned.
- Conductor does not yet prove tests executed or detect unexpected source
  modifications during verification. The adapter imposes a 15-minute
  overall subprocess timeout, not per-check deadlines.

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

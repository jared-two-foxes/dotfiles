# Pi Scaffold task adapter

`index.ts` registers one `scaffold_tasks` tool. `pi/agent/extensions/scaffold/adapter.mjs` validates requests,
resolves Pi's current Git repository root, and invokes the requested
`scaffold tasks OPERATION` command with explicit arguments and JSON stdin. Install
Scaffold with the schema-v2 issue graph API on Pi's PATH.
The only supported persisted work model is the schema-v2 recursive task graph
(`.scaffold/tasks.json`, `.scaffold/.tasks.lock`); no legacy criteria-stack
commands, frame state, fallback or migration are supported. For human inspection
use `scaffold tasks summary --feature ID`, `scaffold tasks issue --feature ID
--task ID`, `scaffold tasks design-select --feature ID` and
`scaffold tasks select --feature ID`. In Pi, the native `scaffold_tasks`
tool exposes the same scoped operations.

Feature preparation flows from Linear or user requirements through
`/skill:init-feature`, using `/skill:design` for bounded engineering
contracts, to the persisted Scaffold task graph. `/skill:implement-task`
implements one eligible issue; `/skill:feature-delivery` sequences tasks and
owns final `validate_feature`. Pi remains the sole reasoning orchestrator;
Conductor is a generic conditional tool runner, not a Scaffold/Linear state
engine. No skill takes over Scaffold lifecycle ownership.

The extension peer dependencies match Pi's native `typebox` convention.
The extension's Scaffold adapter owns the CLI protocol and safe state reads. For an
issue workflow, it requires a native authorization callback before reopening
design, recording a checkpoint, or resuming an issue. The tool and internal
delivery callers call `scaffoldTasks` directly with the
`authenticateIssueMutation` callback, which authenticates the evidence.
The extension formats the acknowledgement shown to Pi.
For copy-based installs, include the repository's `pi/agent/lib/` tree under
the agent home's `lib/` directory.

`lib/scaffold/` contains shared types and structural contracts. It exposes no
CLI, subprocess, or state-file access. The adapter consumes these validators.
Delivery callers own Scaffold reads and writes and supply fresh structures to
shared verification and authorization functions. Checkpoint creation lives in
`extensions/checkpoint/`; handoff coordination lives in Execution Recovery.

The tool itself never edits application source, invokes Conductor, automatically
decomposes or sequences tasks, retries operations, or owns a second state store.
Completion evidence is caller supplied, not authenticated. See [the Scaffold skill](../../skills/scaffold/SKILL.md)
for the design and lifecycle operations, payloads, explicit lifecycle examples and resume guidance.
The tool schema has an object root for provider compatibility; operation-specific
required and forbidden arguments are validated again before launching Scaffold.

Run the mocked adapter tests and existing Conductor/Design regression tests from
the dotfiles repository root:

```sh
node --test tests/pi-scaffold.test.mjs tests/pi-delivery-state.test.mjs tests/pi-conductor.test.mjs tests/pi-design.test.mjs
```

Include the isolated runtime-boundary and supplied-data authorization tests with:

```sh
node --experimental-test-module-mocks --test tests/pi-delivery-state.test.mjs tests/pi-feature-authorization.test.mjs
```

Run the real CLI integration against an unmodified Scaffold checkout (Python 3.11+
and POSIX required for the test launcher):

```sh
SCAFFOLD_SOURCE=/absolute/path/to/scaffold node --test tests/pi-scaffold.test.mjs
```

The test launches the real Scaffold console-entry-point dispatcher in isolated
temporary repositories. It exercises dependent tasks, interruptions, actual state
reload in a fresh adapter module, supplied evidence, failure/retry and recursive
decomposition. Evidence in tests is a fixture; tests do not run Conductor or claim
independent verification. The integration test skips explicitly without a source
checkout; mocked tests run in CI on Linux and Windows. The production tool always
uses `scaffold` on PATH, not this test launcher.

State access is limited to the current repository. The adapter rejects symlinked
`.scaffold`, `.scaffold/tasks.json` and `.scaffold/.tasks.lock` paths, and
rejects unexpected file types at those paths before CLI invocation. Scaffold
uses `.scaffold/tasks.json` and the task-only `.scaffold/.tasks.lock`; no
legacy criteria-stack state, fallback or migration is supported. As with Scaffold's
own local file API, this is not a sandbox against concurrent hostile filesystem
changes. Timeouts, aborts and protocol failures never retry: a write may already
have persisted, so inspect full state with `list` before recovery.

New Design plans can pass `design_ref: "sha256:context"` on `init` with the exact
approved design in feature `context`. The adapter computes the digest before CLI
invocation and checks it on returned feature state. Scaffold uses schema v2 exclusively; older task-state files are rejected without
modification. There is no workflow selector or alternate lifecycle; immutable Git revision references remain supported. Verification
strategies belong in task context, not invented schema fields. See the current
[workflow overview](../../../../workflow-overview.md) and
`tests/pi-task-workflow.test.mjs` for planning, receipts and the checkpoint barrier.

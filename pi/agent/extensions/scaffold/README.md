# Pi Scaffold task adapter

`index.ts` registers one `scaffold_tasks` tool. `adapter.mjs` validates requests,
resolves Pi's current Git repository root, and invokes exactly one
`scaffold tasks OPERATION` command with explicit arguments and JSON stdin. Install
Scaffold with the Phase 1 task API (merged in scaffold PR #10) on Pi's PATH.
The extension peer dependencies match Pi's native `typebox` convention.

No application source edits, Conductor invocation, automatic decomposition,
sequencing, retry loop or second state store live here. Completion evidence is
caller supplied, not authenticated. See [the Scaffold skill](../../skills/scaffold/SKILL.md)
for all ten operations, payloads, explicit lifecycle examples and resume guidance.
The tool schema has an object root for provider compatibility; operation-specific
required and forbidden arguments are validated again before launching Scaffold.

Run the mocked adapter tests and existing Conductor/Design regression tests from
the dotfiles repository root:

```sh
node --test tests/pi-scaffold.test.mjs tests/pi-conductor.test.mjs tests/pi-design.test.mjs
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

State access is limited to the current repository; symlinked `.scaffold`,
`tasks.json` and lock paths are rejected before CLI invocation. As with Scaffold's
own local file API, this is not a sandbox against concurrent hostile filesystem
changes. Timeouts, aborts and protocol failures never retry: a write may already
have persisted, so inspect full state with `list` before recovery.

New Design plans can pass `design_ref: "sha256:context"` on `init` with the exact
approved design in feature `context`. The adapter computes the digest before CLI
invocation and checks it on returned feature state. Scaffold's CLI/schema remains
unchanged; immutable Git revision references remain supported. Verification
strategies belong in task context, not invented schema fields. See the current
[workflow overview](../../../../workflow-overview.md) and
`tests/pi-task-workflow.test.mjs` for planning, receipts and the checkpoint barrier.

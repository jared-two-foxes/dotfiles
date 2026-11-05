# Shared delivery contracts

Extensions own workflow execution and lifecycle mutations. Libraries expose the
data contracts and reusable functions needed by multiple extension callers.

| Directory | Owns |
|---|---|
| `scaffold/` | Feature, issue, binding, and request types; structural request/response validation; issue requirement formatting |
| `verification/` | Verification plans and repair rules, result semantics, review handoffs, receipt applicability, attempt ancestry, and checkpoint history |
| `evidence/` | Content-addressed receipt persistence and integrity checks |
| `git/` | Implementation trees, exact source/index fingerprints, temporary indexes, and tracked-input monitoring |
| `authorization/` | Retained feature direction and amendment authority |
| `delivery-state/` | Delivery contexts, journal audit anchors, bindings, and supplied-data handoff storage |

The Scaffold adapter is in `extensions/scaffold/adapter.mjs`. It validates
requests and responses with `lib/scaffold/contracts.mjs` and owns CLI invocation
and state reads. Delivery-state, evidence, and verification do not import extension
implementations. Workflow coordinators supply fresh feature/task structures and
perform lifecycle writes after the relevant shared authentication succeeds.

Execute and Review composes the execution/check/review pass in `workflow.mjs`.
Its check replay code emits authenticated retained output. Verification code
determines whether that output can be reused. Feature Validation owns check
subprocesses and applies the final full-workspace gate. Task passes retain their
targeted check gate.

Checkpoint creation has three explicit layers.

1. Shared verification authenticates task receipts, reviewed-tree identity, and
   checkpoint ancestry.
2. `extensions/checkpoint/commit.mjs` creates or recovers the exact Git commit,
   preserving the real index and enforcing branch and authorization checks.
3. `extensions/checkpoint/finalization.mjs` and `scaffold.mjs` coordinate task
   completion and checkpoint recording. Execution Recovery invokes finalization
   through Conductor when a commit needs recovery.

A checkpoint failure can occur after task completion or a Git ref update.
Retries use the same successful receipt and reconcile the existing commit and
index before recording completion. Receipts, attempts, and source history remain
available throughout recovery.

The refactor preserves receipt schemas, reference hashes, retention locations,
and exact source fingerprint bytes. Historical guard and evaluator paths remain
supported by forwarding entry points and authentication of their original command
identities. New requests use the verification library's evaluator paths.

For copy-based installations, install the complete `lib/` tree and the
`checkpoint`, `execution-recovery`, `execute-and-review`, `feature-validation`,
and `scaffold` extension directories together. Replace stale copies when
upgrading so retired library implementations cannot shadow the current layout.

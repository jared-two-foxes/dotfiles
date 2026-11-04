# Versioned Pi delivery and recovery

Pi selects issues and authors corrections. Scaffold stores state. Native boundaries
authenticate authority, history and stage evidence. Conductor runs one supplied
command list; it never chooses work or retries it. Executor preserves partial
application. Review remains independent.

## Continuation

Initial execution provides issue identity, baseline, additional requirements,
operations, named checks and checkpoint branch protections. A correction needs only:

```json
{
  "previousAttempt": "pi-evidence:sha256:…",
  "input": "{\"operations\":[]}",
  "contextUpdates": [
    {
      "kind": "add_obligation",
      "id": "quote-status-regression",
      "text": "Reject imported quote statuses outside the supported set.",
      "reason": "Independent review discovered missing validation."
    }
  ]
}
```

Task, baseline, authority, check plan and checkpoint settings are inherited. Every
call must supply fresh operations, including an explicit empty array when no source
change is needed. No source operations are inherited or replayed. Conflicting
identity/baseline fields, old receipts and unexpected source/index/HEAD changes block.

`pi.delivery-context/v1` separates the immutable original feature/issue obligations,
approved issue design, additive design/assumption annotations, stable findings and
the revision history of verification commands. Scaffold owns an append-only
`scaffold.delivery/v1` journal with revision, execution head, in-flight reservation,
monotonic sequence and immutable feature contract. A Git audit ref outside the
evidence directory binds the journal's current head and sequence. These hashes are
local integrity checks, not protection against someone rewriting all local state.

Supported updates are add_obligation, annotate, correct_assumption, revise_design,
propose_addressed, repair_check, add_check and diagnose. Each needs a reason. Changes
append to history. The original contract cannot be replaced. An invocation
repair preserves check names, order, semantic validators and coverage.
`add_check` extends coverage.

To replace a malformed evaluator for a recognized test runner, suspend the
issue, record the revised approved design, resume it and start the same issue.
Continue from the resume handoff with a structured update such as:

```json
{"kind":"repair_check","checkId":"CLI activity","useMeaningfulTestEvaluator":true,"reason":"Replace event labels used as evaluator argv with the built-in positive test-count check"}
```

Omit `command` from that update and inherit the retained check plan. The adapter
installs its built-in meaningful-test evaluator and keeps all check names,
commands and ordering. The original definition stays in the failed receipt.
Conductor reruns verification before review or checkpointing. For Cargo, a
successful process that reports zero passing tests still fails this gate. If the
filter itself selects no tests, repair the command separately and preserve the
approved target coverage.

Legacy verificationRepairReason remains compatible for invocation-only repairs.
Material behavior/scope changes or removal/relaxation of obligations require
approve_delivery_amendment: show the concrete original IDs, replacement and reason
for explicit user confirmation. Apply its authenticated reference through
contextUpdates.apply_amendment. The original text stays retained and replacement
behavior becomes a new obligation requiring independent verification. Structural
prerequisite/decomposition changes still use the approved Design transition.

Review context is assembled from persisted originals, revisions and all relevant
unresolved findings/check failures. Stable occurrence IDs retain provenance rather
than silently merging similar findings. Agent claims do not establish resolution.
Review returns `obligation_assessments` containing obligation_id, disposition and
concrete evidence. Only explicit independent `verified` assessments satisfy open
obligations; missing, unresolved or not_applicable assessments do not authorize a
checkpoint. Final feature review also carries earlier feature findings and issue
contexts. Bookkeeping, READY and migration never mean PASSED.

## Pauses, infrastructure and resources

There is no per-issue five-attempt limit. Every invocation remains counted and
linked, including infrastructure failures. Native classification separates check
failures, findings, invocation/application errors, infrastructure, resources and
protocol/evidence integrity. Three equivalent substantive failures in the last
eight substantive outcomes, or recurring alternating source states, pause with
DIAGNOSIS_REQUIRED. Changing a source hash alone is not evidence of improvement.
Compile → tests → new independently observed findings need not be a stall.

A diagnose update must identify the returned signature and a concrete changed
correction/plan; it permits one bounded diagnostic probe for that signature. An
unsupported assertion of progress cannot keep reopening the loop. Authenticated
rebase/prerequisite handoffs retain history while establishing a newly verified
execution epoch. Infrastructure failures do not erase substantive observations.

Authentication/setup/engine failures open the review circuit immediately. A changed
review executable, model/provider configuration or observed credential-file
generation permits continuation. Secret values or secret hashes are never saved.
For environment-only credential rotation, reviewProbe: true with empty operations
allows one bounded health probe; a failed probe is throttled for five minutes.
Network/provider faults permit one caller-driven probe after five minutes; there
is no background loop. Resource exhaustion returns RESOURCE_PAUSED; an explicit
change to the invocation's time/cost/turn/tool/completion allowance permits another
invocation. Previous usage remains in immutable receipts. A renewed allowance does
not reset the issue sequence. Integrities failures remain recovery blockers.

Workflow cancellation/timeouts terminate the process tree before returning; a
reserved intent without terminal evidence remains INVOCATION_RECOVERY_REQUIRED.
If one terminal receipt exists after a lost response, authenticated continuation
finishes its journal association. Ambiguous/missing terminal proof requires
inspection, not another application of the old operations.

## Check evidence reuse

Empty operations allow verification-only continuation. Check reuse is conservative
and opt-in through checkEnvironmentInputs:

```json
{
  "files": ["toolchain-config.json"],
  "variables": ["LANG"],
  "executables": ["cargo", "rustc"]
}
```

Declare every relevant non-secret environmental input for deterministic checks;
omit the declaration when ambient service/state cannot be measured. Source/index/
HEAD, all check commands and semantic validators, declared inputs and the retained
post-check boundary must match. Missing or uncertain proof reruns checks. Every
reused stage retains its original receipt reference; the new receipt records reuse
explicitly, never fabricates fresh execution. The independent review and commit
gate authenticate those dependencies. Successful earlier checks cannot authorize a
commit by themselves. Source changes conservatively invalidate check reuse.

Recognized Cargo, pytest, Vitest, Jest and Mocha test invocations receive a default
positive-completed-count validator when no explicit evaluator exists. Other runners
need an appropriate explicit successCondition. A zero-test success is not coverage.
Full project validation remains mandatory at the final feature gate.

## Compatibility and repair

Existing receipt bytes and references are unchanged. The first modern continuation
authenticates the old chain, imports original requirements losslessly, retains
findings and records a journal linking its latest receipt and sequence. Attempt
five can continue as six and beyond. Legacy requirement prose is inherited; use
structured updates to revise context. Receipt authentication understands both
legacy fixed-context records and modern versioned-context records. Imported legacy
check/evaluator definitions remain unchanged across subsequent continuations;
new coverage is introduced explicitly through structured additions or repairs.
New supported test checks receive the default meaningful-count evaluator. There is no
64-record lifetime cap; cycle checks remain. Rebase/suspension handoffs retain the
same execution sequence and update the journal anchor.

Missing/corrupt receipts, dropped journal history or contradictory audit anchors
produce EVIDENCE_RECOVERY_REQUIRED. Restore exact authoritative evidence from
backup, or report which proof is unavailable. Never delete evidence, restore/reapply
source, create a replacement issue, or reapprove unchanged direction to continue.
Successful verification with failed commit finalization still uses the existing
checkpoint-only recovery helper.

Current conservative limits: check reuse requires a complete environment declaration;
unknown environments rerun checks. Environment-only secret rotations cannot be
fingerprinted; use a bounded no-source reviewProbe after rotating them.
Long chains are authenticated in-process without a lifetime cap; paged historical
validation is not yet exposed. Context/output/time budgets remain invocation
resource limits. reviewContextMaxBytes defaults to 200000 UTF-8 bytes and may be
explicitly raised up to 8 MiB; oversized context pauses before source execution. Restore of unavailable evidence requires an authoritative backup;
the system cannot manufacture missing independent verification.

Install the matching Scaffold delivery-record implementation and Review's typed
failure/obligation-assessment protocol before deploying this Pi extension.

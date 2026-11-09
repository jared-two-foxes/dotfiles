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

Invocation repairs require structured `contextUpdates.repair_check`; the free-form
`verificationRepairReason` input is rejected.
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

## Supported delivery contract

Delivery requires a recursive issue graph, `versioned-context/v1` policy, a
`pi.delivery-context/v1` context and its existing Scaffold journal for nonzero
continuations. Fixed-context records are retained but cannot be imported or resumed.
Use structured `add_obligation` and `repair_check` updates; replacement requirements
strings are rejected. Only current helper paths and `pi.command-receipts/v2`
producers can authenticate native delivery evidence. Conductor uses request/result
v2 and retained stdout logs; inline previews do not substitute for those logs.
Task and feature storage remain `pi.task-attempt/v1` and `pi.feature-attempt/v1`;
these are current storage schemas, distinct from retired binary interfaces.

No receipt bytes or identifiers are rewritten. Unsupported evidence cannot authorize
review, checkpointing or completion. There is no automatic migration or reset.
Current-format chains retain their full history with no 64-record lifetime cap;
rebase/suspension handoffs retain the same sequence and update the journal anchor.

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

## Choosing a recovery: baseline adoption and its neighbours

Run `inspect_feature_drift` first. It is read-only and names the one applicable recovery.

| Situation | Operation | What it does |
| --- | --- | --- |
| You committed unrelated changes after authorization but **before any task started**; tree is clean | `adopt_feature_baseline` | Records a user-approved **execution baseline** at the new HEAD |
| History was rewritten (rebase) between tasks | `reconcile_feature_rebase` | Re-verifies the rewritten completed prefix |
| A rebase was interrupted mid-task | `recover_interrupted_task_rebase` | Carries the unfinished task's attempts across the rebase |
| A task attempt failed or was interrupted | `previousAttempt` / issue handoff | Ordinary correction within the same feature direction |
| A verified task's commit was lost or interrupted | `checkpoint_verified_task` (repeat) | Commit-only checkpoint recovery |

### Baseline adoption

The **original baseline** (Scaffold `original_baseline`) and the **execution baseline** are different concepts.
Adoption never edits Scaffold, journals, receipts or Git history, and never reapproves the feature.
It adds an authenticated record in the feature evidence store, retained by
`refs/pi-baseline-adoptions/<key>/{record,original,adopted}` created in one atomic ref transaction
(create-only, so concurrent calls have exactly one winner; an evidence record without the refs confers no authority).

- **Eligibility** (checked without mutation): clean worktree and index, feature branch, HEAD equal to the named new commit,
  original baseline an ancestor of HEAD, retained original feature authorization, every task `pending` or `decomposed`
  with no delivery or suspension state, and no attempt, reconciliation or validation evidence for this feature instance.
- **Approval** is a dedicated confirmation naming the old and new commits, the intervening commits and changed paths.
  Feature-direction or execution approval cannot satisfy it. State changing during approval blocks adoption.
- **Checkpoints** begin at the adopted commit. Each checkpoint's provenance carries `adoptionRef` and still carries the
  original `featureBaseRef`. The intervening commits are **not** checkpoints and are never treated as verified.
- **Review scope**: final validation still reviews `original baseline..HEAD`. Its requirements list the adopted commits and
  paths as unverified and in scope; nothing is exempted. Per-task reviews diff from each task's own start.
- **Idempotency**: repeating the same request, or retrying after a lost response, returns the existing record without
  requiring a clean tree. A different baseline once adopted is rejected. An interrupted write leaves no authority.
- **Not supported yet**: adopting commits made after work began, merge-based integration of upstream, and
  `reconcile_feature_rebase` on an adopted feature (it is refused rather than guessed). An upstream that moved is
  advisory in `inspect_feature_drift`; it never invalidates execution by itself.

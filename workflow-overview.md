# Feature preparation and delivery with Pi and Scaffold

Pi is the sole reasoning-based orchestrator. Scaffold persists the **recursive
feature/issue graph**, dependency ordering, designs, phase transitions, delivery
journals, and checkpoint metadata. Conductor is a general-purpose conditional
tool/command execution engine; it neither owns the task graph nor interprets
Linear, approvals or feature-delivery policy. Review independently evaluates
implementation correctness.

## Supported skill boundaries

| Entry point | Responsibility | Changes application source? |
| --- | --- | --- |
| `/skill:design` | Research and produce a bounded engineering design contract, independently or for one issue in a prepared feature | No |
| `/skill:init-feature` | Read a Linear ticket or supplied requirements; reconcile/create the Scaffold root; obtain **one overall feature direction approval**; decompose, design and persist all issue contracts; run `design-finish` | No |
| `/skill:implement-task` | Execute, check, review, correct and checkpoint **one existing eligible issue** with authentic receipts | Yes, within its approved scope |
| `/skill:feature-delivery` | Ensure the feature is prepared; orchestrate dependent issues through `implement-task`, recover graph-level discoveries and invoke final `validate_feature` | Yes, through task execution |
| `/skill:scaffold` | Reference for the native `scaffold_tasks` lifecycle and state contract | No independent execution |

A standalone design is a document/contract, **not** a new Scaffold feature or
execution authorization. `init-feature` uses the design contract for bounded
issues and is the **only feature preparation entry point**. A successful
`init-feature` ends with a persisted, approved task graph in Implement phase,
ready for delivery; it does not start tasks, alter application source, make
checkpoints or publish changes. `feature-delivery` reuses that prepared state
rather than reinitializing it. Invoking it on unprepared work delegates
preparation to `init-feature`, with no redundant direction approval.

## Lifecycle

1. **Research:** Read the Linear ticket or explicit requirements, inspect the
   repository and tests, capture immutable source context and the original Git
   baseline and feature branch. Work must not be authorized on a protected main
   branch or by inferring approval from a ticket's status.
2. **Direction approval:** Present the overall direction and local delivery
   scope; use `approve_feature_direction` for **one** genuine user confirmation.
   This grant persists across sessions within the exact approved boundaries.
   Material changes to objectives, public behavior or explicit constraints
   return to the user; no fabricated per-issue approval is allowed.
3. **Prepare the issue graph:** `init-feature` creates/reconciles the root
   feature through `scaffold_tasks init`, recursively decomposes when needed,
   calls `/skill:design` for each selected bounded issue, persists each
   `design-record`, and executes `design-finish` only when all required
   designs are complete.
4. **Deliver the tasks:** `feature-delivery` selects the next eligible task;
   `implement-task` runs scoped `execute_and_review` attempts, checks,
   independent review and verified Git checkpoints. Parents verify integrated
   original criteria after children. A blocked prerequisite or review finding
   returns to the issue graph through explicit suspension/design/resumption,
   preserving receipts, prior work and baseline.
5. **Validate the feature:** Run meaningful full-feature checks and independent
   final review via `validate_feature`, including revalidation after corrective
   issues. Report actual results and reviewable commits/PRs to the user. Pushes
   and PR publishing require their own user authority; merges remain human-owned.

Use explicit targeted `checks` for leaves and scoped integration checks for
intermediate parents. Save the exact check commands and coverage in the issue
design. Avoid running a full workspace test command for every task; reserve the
full suite for final root/feature validation. Keep a receipt chain's selected
checks fixed across corrections and never equate zero exit status with verified
coverage.

## Inspecting persistent state

Pi uses the native `scaffold_tasks` extension. To inspect the same graph from a
terminal, use the supported task-only CLI:

```sh
scaffold summary --feature SA-585
scaffold issue --feature SA-585 --task SA-585
scaffold design-select --feature SA-585
scaffold select --feature SA-585
```

State lives only in one append-only ledger per feature instance, `.scaffold/features/<feature>.<instance>/ledger.jsonl` (schema version 3); the task-only
lock is `.scaffold/.tasks.lock`. `scaffold status` and `scaffold stack`
are **retired**, not alternate work-tracking interfaces. Historical
`.criteria-stack.json` and `.criteria-stack.lock` files are not consumed,
migrated or deleted automatically. Do not manually edit persistent state or
introduce compatibility paths for the former stack model.

See `pi/agent/skills/init-feature/SKILL.md`,
`pi/agent/skills/design/SKILL.md`,
`pi/agent/skills/implement-task/SKILL.md`,
`pi/agent/skills/feature-delivery/SKILL.md` and
`pi/agent/extensions/scaffold/README.md` for exact workflow contracts.

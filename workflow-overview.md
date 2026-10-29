# Pi issue graph workflow

Pi is the reasoning orchestrator. Scaffold persists the issue graph and its
approved designs. Conductor performs one exact implementation/check/review attempt;
Review independently evaluates the result. The workflow has three phases:
Research → Design → Implement.

## Research

Inspect the repository, clarify the user's ticket, original acceptance criteria
and constraints, and establish the feature branch and original Git baseline.
Agree the scope. A complete system design is not required before creating work.

## Design downward

1. `scaffold_tasks init` persists the agreed ticket and creates its root issue.
   Supply the original full `baseline`, `branch`, criteria and immutable design
   reference. `sha256:context` binds the exact agreed context. There is no optional
   workflow selector: schema v2 issue graphs are the sole supported lifecycle.
2. Use `list` and `design-next` to select an issue beneath approved parent and
   prerequisite contracts. Inspect relevant code and inherited constraints.
3. Run one bounded design pass. Discuss consequential decisions and obtain user
   confirmation of the proposed solution. If the issue is too large, identify
   immediate responsibilities, interfaces and dependencies, then `decompose` it.
   A small independently verifiable issue can remain a leaf.
4. `design-record` retains the confirmed summary, verification strategy and actual
   approval, binding immediate children. Continue downward until all required
   designs are confirmed. `design-finish` then permits implementation.

Each issue has one outcome, acceptance criteria, relevant context, constraints,
explicit dependencies and optional origin reference (ticket, design, review or
discovery). Definitions remain fixed; design revisions retain previous records.
Changed contracts invalidate unfinished dependent designs. No application source
writes or implementation checks occur during Design.

## Implement upward

1. `next` selects an eligible issue after required children and dependencies.
   Recover its confirmed design; prepare exact Executor operations for that issue
   and obtain separate execution approval. `start` the explicit issue.
2. `execute_and_review` performs one attempt with fixed criteria, design,
   verification commands and baseline. Pi interprets diagnostics. Routine defects
   within the agreed solution remain corrections on this issue, retaining receipts
   and the five-attempt budget. Stop after repeated failures without progress.
3. Inspect actual meaningful checks, independent APPROVED review and authentic
   evidence before completing the issue in Scaffold. Then separately authorize
   `checkpoint_verified_task`. Every resolved issue gets a verified commit;
   verification-only parents get empty commits. Checkpoint bookkeeping must finish
   before another issue starts.
4. Parents verify their original criteria after children finish. Completion never
   propagates automatically. After all nodes have evidence and checkpoints, run
   UI-authorized cumulative `validate_feature` against the original ticket and
   approved issue contracts.

`next: null` is not feature completion: inspect phase, active/blocked/suspended
issues, designs, missing checkpoints and final verification evidence.

## Discoveries return to Design

New prerequisites or responsibilities found by Pi, checks or review enter the
same graph. For active unfinished implementation, UI-authorized `suspend_issue`
authenticates the latest receipt and retains source, index, untracked files and
historical snapshots before parking changes in a saved stash. It reopens Design
on a clean baseline. Never stash/reset from Bash or create a replacement issue to
reset attempts.

Design and confirm the new issues, finish the design graph, implement/checkpoint
prerequisites, then use UI-authorized `resume_issue`. It authenticates checkpoint
history and source/index transplants, restores saved work and retains a continuation
handoff. Start the same issue and use returned resume fields plus freshly approved
operations. Three consumed attempts mean attempt four. READY is not PASSED.
Conflicts block with saved work intact; stashes and audit refs remain retained.

Without unfinished source, reopen Design directly. Final-review corrections become
new dependent issues after completed nodes. Original criteria, previous failures
and completed checkpoints remain retained.

## Recovery and boundaries

Recover phase, designs, lifecycle history, Git state and local content-addressed
receipts before advancing. Use returned suspension/handoff references to recover
interrupted operations; do not replay source blindly. Receipts remain local to the
checkout. Design, source execution, checkpoints, recovery, final validation and
publishing have separate authority scopes; session checkpoint grants expire.

Old schema-v1 task files are unsupported and rejected without modification.
There is no alternate execution lifecycle or automatic migration. A user-performed
rebase still needs explicit authenticated rebase recovery before further checkpoints.

Tests: `SCAFFOLD_SOURCE=/path/to/scaffold node --test tests/*.test.mjs`. Integration
fixtures use real Git and Scaffold with deterministic Conductor/Review responses;
they do not establish live-model compliance.

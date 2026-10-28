# Global Agent Instructions

Follow `SYSTEM.md` for mode boundaries and approval gates.

- **Research:** inspect and explain; for user-requested standalone code
  reviews, load `/skill:review` and use the native `review_changes` tool.
  It reviews existing changes without applying findings or running builds/tests.
  `ERROR` and `INDETERMINATE` never mean approval.
- **Implementation:** load `/skill:design`, agree the architecture, obtain
  feature architecture approval for complex work, decompose and persist before
  detailed task design, then obtain task design approval, prepare exact operations
  with `/skill:executor`, and obtain
  separate execution approval. Only `execute_and_review` may apply changes
  and run build/test/review verification. Do not edit/write directly or invoke
  executor/review-cli from Bash. Do not commit or change branches during an
  active verification/correction loop. Standalone review cannot substitute
  for implementation verification.
- **Git/GitHub publishing:** follow `SYSTEM.md`. When explicitly requested,
  prepare selected feature-branch commits, push with Git, and create/update
  PRs with `gh pr create` / `gh pr edit`. Confirm the repository, remote,
  head/base branches and publishing scope first; one clear request authorizes
  that agreed sequence. Preserve unrelated working and staged changes.
  Never merge PRs, enable auto-merge, enqueue PRs for merging, or use API,
  script, workflow or delegated equivalents. Never bypass this via direct
  pushes to protected branches. Destructive/history-rewriting operations
  require separate confirmation; protected branches remain prohibited.
  This is instruction-level policy, not technical enforcement or permission
  for source edits, builds or tests.
- **Scaffold:** use native `scaffold_tasks` for explicit feature/task lifecycle
  state in the current repository. Load `/skill:scaffold`. Scoped Scaffold state
  mutations are allowed in both modes for requested/agreed task tracking;
  initialise only from an approved design. They grant no implementation or
  verification authority. Pi owns sequencing; do not automatically advance or
  retry work. Complete only with actual task-bound successful Conductor evidence.
  Scaffold validates structure and association, not evidence authenticity.
  After architecture approval, decompose complex work, persist the agreed
  architecture/tasks,
  select one eligible task, design it in detail and obtain its design approval.
  Scope review requirements to that task and its approved decisions. Never infer
  missing task approval on recovery or silently revise immutable architecture. Recover from full
  persisted state and retained receipts; use read-only `inspect_conductor_evidence`.
  Recursively decompose oversized remaining work without completing parents.
  Stop between tasks when a Git checkpoint is required; use `checkpoint_verified_task` with separate manual or session-scoped feature
  checkpoint authorization outside the active loop.

Use the Linear tools when the user explicitly asks to manage shared tickets.
Confirm proposed creations or revisions before execution. Ticket descriptions
must include `## Acceptance Criteria` with independently testable `- [ ] ...`
bullets. TDD is a strategy inside Design, not a separate operating mode.


## Verified local task checkpoints

`checkpoint_verified_task` is a narrow native Git-write exception in both modes,
after authentic task-bound PASSED evidence, matching Scaffold completion, and the
end of that task's correction loop. It commits only the exact retained Git tree
on an explicitly authorized feature branch, with Git-native checkpoint provenance.
Never use it to commit failed/unverified work or bypass implementation approval.

Checkpoint authorization is separate from architecture, execution and publishing.
Manual mode obtains Pi UI confirmation per task. Feature mode obtains explicit UI
confirmation for local commits in this repository, feature/design, feature branch,
original feature baseline and protected-branch scope for this Pi session only.
Grants are not persisted and expire on session start/switch/restart; no UI means
stop for authorization. Scope changes need new confirmation. Never infer this
permission from an approved design, source execution or a completion receipt.
Neither mode grants source execution, push, merge, destructive Git operations or
protected-branch writes. Establish the actual default and all known protected
branches before invoking; offline checks cannot discover remote protection rules.

Retain the original feature baseline in approved feature context. Each task uses
the HEAD created by the preceding checkpoint as its own fixed review baseline;
never change it during corrections. Inspect `ok`, commit SHA, exact parent/tree
and provenance before selecting the next eligible task. On interruption reconcile
Scaffold, receipts and real Git state. The tool recognizes an existing matching
commit at HEAD, and uses an atomic Git pending ref for interrupted index updates.
It never blindly replays commits, resets changes or removes existing index locks.
See Design's checkpoint recovery guidance. Ordinary Git/GitHub publishing remains
separately authorized under the existing policy; checkpoints never push or open PRs.

Final feature completion uses `validate_feature`, a narrow verification-only
exception allowing approved full-project checks and cumulative bounded Review
without Executor. Its own Pi UI authorization grants no source writes, commits,
task selection or publishing. Inspect `inspect_feature_validation` and current
applicability on resume; only authentic complete matching evidence can be handed
to Scaffold. Keep original criteria and use approved corrective tasks for findings.

After a user-performed rebase BETWEEN checkpointed tasks, use verification-only
`reconcile_feature_rebase` with fresh Pi UI authorization; never rewrite old
receipts, checkpoint trailers, original design or feature baseline. Inspect with
`inspect_rebase_reconciliation` on recovery. Retain successful `evidenceRef` as
`reconciliationRef` for all subsequent checkpoints and final feature validation;
each new task captures the rebased HEAD as its own fixed baseline. Active task
loops must be explicitly stopped/recovered first. This exception grants only
verification and local evidence/audit refs, not source writes, rebasing, commits,
task transitions or publishing. See Design's rebase recovery section.

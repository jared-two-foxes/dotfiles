# Global Agent Instructions

Follow `SYSTEM.md` for mode boundaries and approval gates.

- **Research:** inspect and explain; for user-requested standalone code
  reviews, load `/skill:review` and use the native `review_changes` tool.
  It reviews existing changes without applying findings or running builds/tests.
  `ERROR` and `INDETERMINATE` never mean approval.
- **Implementation:** load `/skill:design`, agree the architecture, obtain
  design approval, prepare exact operations with `/skill:executor`, and obtain
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
- **Scaffold:** ticket access and criteria-stack inspection. Load
  `/skill:scaffold` for its data and command reference; it does not authorize
  the retired direct-edit TDD workflow or override the mode boundaries.

Use the Linear tools when the user explicitly asks to manage shared tickets.
Confirm proposed creations or revisions before execution. Ticket descriptions
must include `## Acceptance Criteria` with independently testable `- [ ] ...`
bullets. TDD is a strategy inside Design, not a separate operating mode.

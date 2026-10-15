# Global Agent Instructions

Follow `SYSTEM.md` for mode boundaries and approval gates.

- **Research:** inspect and explain; for user-requested standalone code
  reviews, load `/skill:review` and use the native `review_changes` tool.
  It reviews existing changes without applying findings or running builds/tests.
  `ERROR` and `INDETERMINATE` never mean approval.
- **Implementation:** load `/skill:design`, agree the architecture, obtain
  design approval, prepare exact operations with `/skill:executor`, and obtain
  separate execution approval. Only `execute_and_review` may apply changes
  and run build/test/review verification. Do not edit/write directly, invoke
  executor/review-cli from Bash, commit or push. Standalone review cannot
  substitute for implementation verification.
- **Scaffold:** ticket access and criteria-stack inspection. Load
  `/skill:scaffold` for its data and command reference; it does not authorize
  the retired direct-edit TDD workflow or override the mode boundaries.

Use the Linear tools when the user explicitly asks to manage shared tickets.
Confirm proposed creations or revisions before execution. Ticket descriptions
must include `## Acceptance Criteria` with independently testable `- [ ] ...`
bullets. TDD is a strategy inside Design, not a separate operating mode.

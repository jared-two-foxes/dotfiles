   # Global Agent Instructions

   This environment uses two CLI tools alongside the agent's own editing
   capability:

   - **scaffold** — Ticket access and criteria-stack management. Fetch Linear
     tickets, inspect the criteria stack, and push/pop criterion frames. Load
     the `scaffold` skill with `/skill:scaffold` for command details.
   - **review-cli** — AI code review against a repository diff via a bounded
     agent loop with read-only tools. Load the `review` skill with
     `/skill:review` for invocation, request/result protocols, and tool
     details.

   The agent writes tests and implementation code directly using its `edit`
   and `write` tools. review-cli provides independent verification — the
   review agent has no knowledge of what the driving LLM intended, so it
   reviews the code objectively.

   When the user asks to plan work and create Linear tickets, use the
   `linear_create_ticket` and `linear_update_ticket` tools directly. Structure
   tickets with an `## Acceptance Criteria` section containing `- [ ] ...`
   checkbox bullets so they can be pushed onto the criteria stack via
   `scaffold stack push`.

   When the user wants to work through a ticket's acceptance criteria with a
   structured red-green TDD cycle — grounding each criterion via review-cli,
   writing tests, implementing to green, and running a final validation —
   load the `tdd` skill with `/skill:tdd`.
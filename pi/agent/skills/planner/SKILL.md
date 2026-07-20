---
name: planner
description: >
  Planning & Ticket Creation — the workflow for turning a research
  investigation into Linear tickets that are immediately consumable by the
  scaffold TDD pipeline (push-ticket / next-step) without further
  enrichment. Covers the planning workflow (discovery, structuring,
  confirmation, creation), the required ticket format (## Acceptance
  Criteria with - [ ] checkbox bullets, 3-7 independently-testable criteria),
  and the splitting decision (when a single ticket should become a parent
  + children). Use when the user asks to plan work and create Linear
  tickets. The scaffold skill remains the authority on the pipeline itself;
  this skill is the agent-facing workflow that feeds it.
---

# planner — Planning & Ticket Creation

This is the opt-in side channel to the researcher persona. Your primary
role is still research and analysis; ticket creation only happens when the
user explicitly asks for it. Load this skill to get the workflow, the
ticket format, and the splitting rules in one place so the tickets you
produce are ready for `scaffold push-ticket` without any further
preparation.

## When to use this skill

When the user asks you to plan future work and push it to Linear, e.g.
"plan the work for X and create tickets", "break down the next feature
into Linear tickets", "I want to track this as tickets".

Do **not** use it (and do not create tickets) when the user only asks for
analysis, recommendations, or a plan written to `.pi/plan.md` — that is
plain research / `write_plan`, not ticket creation.

## The planning workflow

1. **Discovery** — investigate the codebase exactly as you would for any
   research question: read the relevant files, find the existing patterns,
   check what work is already done, identify the edge cases. The only
   difference from a research answer is what you produce at the end.

2. **Structuring** — break the work into tickets. Apply the splitting
   decision (below) per ticket. Write each ticket's title, description,
   and `## Acceptance Criteria` section per the format spec (below).

3. **Confirmation** — present the full proposed ticket(s) to the user:
   title, description, and acceptance criteria. Ask for explicit
   confirmation before any `linear_create_ticket` call. This is a visible,
   non-reversible action against a shared Linear workspace.

4. **Creation** — once confirmed:
   - Resolve the team: if the user gave a team *name*, call
     `linear_list_teams` and match case-insensitively to get the UUID. If
     the user gave no team, ask which team the tickets belong to.
   - Create the parent first (omit `parent_id`), then each child with the
     parent's human-readable identifier as `parent_id`.
   - Report each created ticket's identifier and URL back to the user.

## Ticket format

Every ticket description must follow this structure so the scaffold
pipeline's `extract_acceptance_criteria()` can parse it without
modification:

```markdown
[1-3 sentence description of what this ticket does and why]

## Acceptance Criteria
- [ ] [specific, testable criterion — describes an observable outcome,
      not an implementation detail]
- [ ] [specific, testable criterion]
- [ ] [specific, testable criterion]
(3-7 items)
```

### Format rules (derived from the pipeline source)

| Rule | Why |
|------|-----|
| Section header is exactly `## Acceptance Criteria` | The parser's regex looks for this exact heading. |
| Criteria are `- [ ] ...` checkbox bullets | Any `-`, `*`, or numbered list item under the heading is extracted, but `- [ ]` is the established convention. |
| Criteria are independently testable | The pipeline's grounding check and test-writer depend on each criterion being testable in isolation. |
| No `verify: test\|manual` tags needed | The narrow-plan step adds these tags; the original ticket doesn't need them. |
| No `existing_test:` tags needed | Added by narrow-plan, not by the ticket author. |
| 3-7 criteria per ticket | Too few = trivial work that may not need a ticket; too many = should be split. |

### Context section (recommended, not parsed mechanically)

After the acceptance criteria, include a short context block so an
implementer (human or the scaffold plan step) has the background it needs:

```markdown
### Context

- [relevant files/patterns discovered during investigation]
- [edge-case decisions made during planning]
- [terms defined, scope boundaries clarified]
```

This mirrors the `### Context` section format used by the `to-tickets`
skill. The pipeline doesn't parse it, but it is what makes the ticket
complete enough that `scaffold push-ticket` can run plan+narrow without
needing to ask for clarification.

## Splitting decision

Per criterion below, reach a verdict for each ticket you draft. Borrowed
from `split-ticket.prompt.md`:

| Signal | Verdict |
|--------|---------|
| All criteria touch the same module/package | no-split (single ticket) |
| Criteria fan across multiple unrelated modules or layers | split (parent + children) |
| Criteria have strict dependency order (A must land before B) | split as sequential children |
| Criteria are fully independent (no shared touched files) | split as parallel children |

Prefer "no-split" liberally. The goal is not to maximise the number of
tickets — it is to avoid implementation passes so broad they become
unreliable. If in doubt, keep the work in one ticket.

**When splitting:** Create the parent ticket first. The parent carries a
high-level description (and may carry overall-outcome criteria, or no
criteria of its own). Then create each child with its specific acceptance
criteria, passing the parent's identifier as `parent_id`. Together, the
children must cover every acceptance criterion from the parent with no
gaps and no overlaps.

## Quality bar

Before presenting tickets to the user for confirmation, self-check each
one:

- Each acceptance criterion is **independently testable** — describes an
  observable outcome, not an implementation detail.
- The ticket is complete enough that the scaffold plan + narrow-plan steps
  could work without asking the user for clarification.
- Every **named file/symbol exists** as described — `review-ticket` will
  flag references that don't resolve. Verify by reading during discovery.
- No work the ticket describes is **already done** — `review-ticket` will
  flag criteria that already pass. Check during discovery.
- 3-7 criteria, no bundled unrelated work; splitting verdict applied.

The user-confirmation gate before creation is the primary safety net, but
getting the above right means the tickets survive `review-ticket` /
`narrow-plan` on the first pass.
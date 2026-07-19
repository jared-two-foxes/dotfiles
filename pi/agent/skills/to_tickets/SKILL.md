---
name: to_tickets
description: >
  Convert unstructured context — conversation transcripts, design notes,
  Slack dumps, ad-hoc observations — into properly formatted
  scaffold-compatible ticket files. Use when the user has work to capture
  that isn't already a Linear ticket and can't (or shouldn't) go through
  the full Linear → push-ticket flow first. Produces local .md files
  consumable by scaffold push-ticket --ticket-file-in, feeding the
  criteria stack directly without requiring a Linear ticket ID upfront.
  Complements the planner skill (which creates tickets in Linear); this
  skill targets the scaffold pipeline directly.
---

# to_tickets — Context to Scaffold Ticket Files

This skill converts unstructured context into properly formatted ticket
`.md` files written to disk, ready for `scaffold push-ticket
--ticket-file-in`. The user provides raw context; this skill handles all
the formatting and grounding work.

## When to use this skill

When the user:
- Pastes a conversation transcript and wants to capture it as trackable work
- Has design notes, ad-hoc observations, or a Slack thread to convert
- Wants to inject work into the criteria stack without a Linear ticket
- Says "turn this into a ticket" with unstructured input

Do **not** use it when:
- The user wants tickets created in Linear — use the planner skill instead
- The user already has a structured ticket — use `scaffold push-ticket` directly

## Difference from the planner skill

| | planner | to_tickets |
|---|---|---|
| Input | A research question to investigate | Existing unstructured context |
| Output | Tickets created in Linear | Local `.md` files for scaffold |
| Linear required | Yes (team UUID, create call) | No |
| Use case | Plan future work | Capture ad-hoc / in-flight work |

## Workflow

### 1. Read the context fully

Consume the user's entire input. Extract the distinct work items present
— a conversation may describe two or three independent pieces of work
bundled together.

### 2. Investigate the codebase

Use read-only tools to ground each extracted work item in real code.
Find the relevant files, existing patterns, and named symbols before
writing any criterion that references them.

**Never** write an acceptance criterion that references a file, function,
or symbol you haven't verified actually exists in the codebase — or that
the ticket explicitly says to create. The pipeline's grounding check will
decline criteria that mention phantom symbols, and the failure is silent:
the pipeline simply rejects the frame.

### 3. Synthesize tickets

Break the extracted work into one or more tickets. Apply the **splitting
decision** (below) to decide how many tickets to produce.

For each ticket:
- Choose a short kebab-case ID: `adhoc-{short-name}` (e.g.
  `adhoc-cache-invalidation`). This is the ID passed to `scaffold
  push-ticket` and becomes the branch name under `git_workflow`.
- Write a 1–3 sentence description of what the ticket does and why.
- Write an `## Acceptance Criteria` section with `- [ ] ...` checkbox
  bullets (3–7 items, independently testable).
- Append a `### Context` section with relevant file paths, patterns
  discovered, edge-case decisions, and terms defined.

### 4. Write the ticket files

Call `write_ticket_file` once per ticket:
- `filename`: `.ticket-{id}.md` (e.g. `.ticket-adhoc-cache-invalidation.md`)
- `content`: the full ticket markdown

### 5. Report the next steps

After writing, tell the user exactly what to run for each ticket:

```
scaffold push-ticket adhoc-cache-invalidation \
  --ticket-file-in .ticket-adhoc-cache-invalidation.md
```

If multiple tickets were produced, give the commands in the correct
order (dependencies first). If the stack is already in progress, show
the `--prepend` variant:

```
scaffold push-ticket adhoc-cache-invalidation \
  --ticket-file-in .ticket-adhoc-cache-invalidation.md --prepend
```

## Ticket format

Every ticket file must follow this structure exactly so the scaffold
pipeline's `extract_acceptance_criteria()` can parse it:

```markdown
# {title}

{1–3 sentence description of what this ticket does and why}

## Acceptance Criteria
- [ ] {specific, testable criterion — observable outcome, not implementation detail}
- [ ] {specific, testable criterion}
- [ ] {specific, testable criterion}
(3–7 items)

### Context

- {relevant files/patterns discovered during investigation}
- {edge-case decisions made during synthesis}
- {terms defined, scope boundaries clarified}
```

### Format rules

| Rule | Why |
|------|-----|
| Section header is exactly `## Acceptance Criteria` | The parser's regex looks for this exact heading. |
| Criteria are `- [ ] ...` checkbox bullets | The established pipeline convention. |
| Each criterion is independently testable | The grounding check and test-writer treat each criterion in isolation. |
| No `verify:` or `existing_test:` tags | The pipeline's narrow-plan step adds these — the ticket author doesn't. |
| 3–7 criteria per ticket | Fewer = likely trivial; more = split. |

## Splitting decision

| Signal | Verdict |
|--------|---------|
| All criteria touch the same module/package | no-split (single ticket) |
| Criteria fan across multiple unrelated modules | split (multiple tickets) |
| Criteria have strict dependency order | split; push in dependency order or use `--prepend` |
| Criteria are fully independent (no shared files) | split as independent parallel tickets |

Prefer no-split liberally. The goal is not to maximise the number of
tickets — it is to avoid implementation passes so broad they become
unreliable. If in doubt, keep the work in one ticket.

## Quality bar

Before writing files, self-check each ticket:

- Each criterion is **independently testable** — observable outcome, not
  an implementation step.
- Every **named file/symbol exists** in the codebase (or the ticket says
  to create it).
- No work is **already done** — check the codebase; don't propose
  criteria the pipeline will immediately narrow away.
- The ticket is complete enough that `scaffold push-ticket` can run
  plan+narrow without needing to ask the user for clarification.
- 3–7 criteria, splitting verdict applied.

## Key scaffold flags

| Flag | Effect |
|------|--------|
| `--ticket-file-in <path>` | Read the ticket from a local file instead of fetching from Linear. |
| `--prepend` | Insert the new ticket's frames ahead of an in-progress stack as a prerequisite; the in-progress stack resumes automatically afterward. |
| `--force` | Replace the in-progress stack entirely (use only when deliberately abandoning it). |

# Agent Usage Guide: Context Injection Model

This document describes how the TDD agent system works under the
**push (context injection)** model. Each agent expects key files to be
included in the prompt as #file:{filename} blocks rather than reading
them from disk. This guide covers the expected workflow, the files each
agent consumes and produces, and example prompts for every agent.

## How Context Injection Works

In orchestrated environments, the orchestrator (or the user) includes
relevant file contents as #file:{filename} blocks directly in the
prompt. The agent checks its prompt context **first** before falling
back to reading from disk. This reduces tool-call overhead and makes
the agent stateless - everything it needs is in the prompt.

**Rule of thumb:** When invoking an agent, include the files listed in
the **Prompt includes** column below. The agent handles the rest.

## Files Overview

| File | Produced by | Consumed by | Purpose |
|------|-------------|-------------|---------|
| .updated-plan.md | Interrogator | Planner | Edge cases and open questions discovered from a ticket/description |
| .tdd-plan.md | Planner | Tester, Implementor, Validator, Reviewer | Shared spec: AC, plan, edge cases |
| .reinjection.md | Orchestrator | Tester, Implementor | Reentry state for refinement flows |
| .tdd-test-files.md | Tester (optional) | Humans only | Human-readable test file audit |
| .session-note.md | Lorekeeper | Librarian | Knowledge session record |
| config.md | User/Setup | Lorekeeper, Librarian | Knowledge base config |

Agent files themselves define prompts. They use #file:{filename} or
{filename} inline.

---

## Workflow Sequence

`
┌─────────────────────────────────────────────────────────┐
│                STANDARD TOGGLESTER FLOW                  │
│                                                         │
│  Interrogator ─> Planner ─> Tester ─> Implementor ──> Validator │
│   (optional)                            │              │       │
│                                          │              └─> Reviewer│
│                                          │                       │
│              ◄── Feedback loop ──►                      │
│              (Implementor or Tester reentered            │
│               with .reinjection.md)                     │
└─────────────────────────────────────────────────────────┘
`

### Step-by-step

0. **Interrogator** (optional) - Given a ticket (#file:{ticket_name}) or
   plain-language prompt, discover edge cases and open questions and
   write .updated-plan.md. Fails fast if the source is too thin to
   reason about. Run this before Planner when the source hasn't already
   been interrogated.

1. **Planner** - Single-shot. Given a ticket/prompt with **explicit**
   acceptance criteria (optionally with .updated-plan.md and/or codebase
   context), produce a .tdd-plan.md with AC, edge cases, implementation
   plan, and complexity estimate. Fails fast — no AC derivation, no
   confirmation round-trip — if the source lacks explicit AC or has
   unresolved open questions from Interrogator.

2. **Tester** - Given the plan (from prompt context), write failing
   tests that encode the acceptance criteria. Optionally writes
   .tdd-test-files.md for human audit.

3. **Implementor** - Given the plan and failing tests (from prompt
   context), implement production code to satisfy the tests.

4. **Validator** - Given the plan (from prompt context), map each AC
   to evidence and return APPROVED or REVISIONS REQUIRED.

5. **Reviewer** - Given the plan (from prompt context), review code
   quality, duplication, security basics, and scope fit.

### Refinement loops

If the user provides feedback (build errors, test failures, code review):

- Agent reads the feedback
- Agent reads .reinjection.md from prompt context (contains previous
  attempt state + the feedback)
- Agent makes a minimal targeted fix
- **Do not re-invoke Planner** - the plan is fixed

---

## Example Prompts

### Interrogator

The Interrogator accepts a ticket as a #file:{ticket_name} block or a
plain-language description, optionally with codebase context, and writes
.updated-plan.md with edge cases and open questions for Planner to
consume.

`
Your task: Find edge cases and open questions for this ticket.

#file:ticket.md
Ticket: Add email notifications for failed login attempts
When a user fails to log in more than 5 times in 15 minutes,
send an email notification to the account's registered email address.
`

---

### Planner

The Planner accepts a ticket as a #file:{ticket_name} block or a
plain-language description **with explicit acceptance criteria**,
optionally with .updated-plan.md and codebase context (file tree + key
source files) to inform the implementation plan. It fails fast if no
explicit AC/Definition-of-Done section is present — it no longer derives
criteria or asks for confirmation.

`
Your task: Plan the implementation for this feature request.

#file:ticket.md
Ticket: Add email notifications for failed login attempts
When a user fails to log in more than 5 times in 15 minutes,
send an email notification to the account's registered email address.

Acceptance Criteria:
- Email is sent after 5 failed attempts within a 15-minute window
- Email goes to the account's registered email address
- Failed attempts outside the window reset the counter

#file:codebase-tree.txt
src/
  auth/
    login.go
    session.go
  notifications/
    email.go
  models/
    user.go

#file:src/auth/login.go
[content of login.go - existing login logic]
`

The Planner checks whether the ticket has explicit AC. If not, it stops
and reports the gap instead of writing a plan. If .updated-plan.md is
included, its edge cases feed directly into .tdd-plan.md.

---

### Tester - First invocation

The Tester needs the acceptance criteria and edge cases. These come from
.tdd-plan.md included in the prompt.

`
Your task: Write failing tests for these acceptance criteria.

#file:.tdd-plan.md
## Source
Ticket: Add email notifications for failed login attempts

## Acceptance Criteria
<!-- source: ticket -->
- [ ] After 5 failed login attempts within 15 minutes, trigger
      email notification
- [ ] Email is sent to the account's registered email address
- [ ] Failed attempts outside the 15-minute window are tracked
      separately (sliding window reset)

## Edge Cases
- Exactly 5 failures - should trigger
- 4 failures - should not trigger
- 6th failure after email sent - should trigger again
- User has no registered email - should log warning, not crash

## Implementation Plan
- src/auth/login.go: Track failed attempts with timestamps
- src/notifications/email.go: Add sendLoginAlert function
- ...

## Complexity
complex
`

The Tester writes failing tests in the project's test convention and
optionally writes .tdd-test-files.md.

---

### Tester - Refinement with feedback

When the user provides feedback about test adequacy, include the
.reinjection.md that captures the previous attempt.

`
Your task: Refine the tests based on this feedback.

Feedback: The tests don't cover the case where the user's email
address changes between the failed attempts and the notification
trigger. Also, the sliding window test is too tightly coupled to
time - use a mock clock instead.

#file:.tdd-plan.md
[full .tdd-plan.md - unchanged from the original plan]

#file:.reinjection.md
### Attempt
- **Agent**: tester
- **Files modified**: tests/auth/login_test.go
- **Summary**: Wrote tests for login failure notification

### Feedback
The tests don't cover the email-change edge case. The sliding
window test is coupled to real time.
`

---

### Implementor - First invocation

The Implementor needs the plan and the test files, both injected as
context.

`
Your task: Implement the changes described in the plan.

#file:.tdd-plan.md
[full .tdd-plan.md - plan, AC, edge cases]

#file:tests/auth/login_test.go
[test file content - failing tests that encode the AC]
`

The Implementor reads the plan for *where* to make changes and what
approach to take, and reads the tests to understand the expected
behaviour.

---

### Implementor - Refinement with feedback

When the compiler or tests produce errors, include the reentry state.

`
Your task: Fix the implementation based on this error.

#file:.tdd-plan.md
[full .tdd-plan.md]

#file:tests/auth/login_test.go
[test file - unchanged from what was written]

#file:.reinjection.md
### Attempt
- **Agent**: implementor
- **Files modified**: src/auth/login.go, src/notifications/email.go
- **Summary**: Added failed-attempt tracking and email notification

### Feedback
error: undefined reference to 'sendLoginAlert' at src/auth/login.go:87
`

---

### Validator

The Validator is read-only and only needs the acceptance criteria.

`
Your task: Verify that all acceptance criteria are met.

#file:.tdd-plan.md
[full .tdd-plan.md - especially the AC section]
`

The Validator maps each AC to evidence (test names, code assertions)
and returns APPROVED or REVISIONS REQUIRED.

---

### Reviewer

The Reviewer needs the plan to check scope fit and edge-case coverage.

`
Your task: Review the code quality of the changes.

#file:.tdd-plan.md
[full .tdd-plan.md - for scope and edge case checks]
`

The Reviewer also runs git status / git diff to identify changed
files, then reviews each one for duplication, security, conventions,
scope fit, and readability.

---

### Lorekeeper

Lorekeeper accepts session context and config as injected files for
continuing sessions.

`
Your task: Help me understand how the login throttling works in this project.

#file:.session-note.md
### Login Throttling Investigation
**Summary:** The throttle uses a sliding-window counter stored in Redis.
**Details:** Window size is 15 minutes, threshold is 5 attempts.
Key format is 	hrottle:{user_id}.
**Open questions:** Is the window reset on successful login?
`

If config.md is also available (sets VAULT_ROOT and project structure),
include it:

`
#file:config.md
VAULT_ROOT: /home/user/.knowledge-base
current_project: repo-a
`

---

### Librarian

Librarian accepts the session note and config as context for filing.

`
Your task: File the session note into the knowledge base.

#file:.session-note.md
[full session note with topics to file]

#file:config.md
VAULT_ROOT: /home/user/.knowledge-base
current_project: repo-a
`

The Librarian reads both, files each topic into the appropriate KB
location, updates index.md, then clears the session note.

---

## Structured Prompt Template

For automated invocation (e.g., an orchestrator script), use this
template to compose prompts:

`
Your task: <role-specific task description>

#file:<filename>.<ext>
<file content>
`

The agent checks the prompt context before reading disk, so the
order is: task description, then file blocks, then optional free-form
instructions.

---

## Quick Reference: What to Include Per Agent

| Agent | Include in prompt | Agent outputs |
|-------|------------------|---------------|
| **Interrogator** | #file:{ticket_name} or description | .updated-plan.md |
| **Planner** | #file:{ticket_name} or description (with explicit AC) + .updated-plan.md (optional) + codebase context (file tree + key files) | .tdd-plan.md |
| **Tester** (first) | .tdd-plan.md | Test files, optionally .tdd-test-files.md |
| **Tester** (refine) | .tdd-plan.md + .reinjection.md + feedback | Updated test files |
| **Implementor** (first) | .tdd-plan.md + test files | Production code |
| **Implementor** (refine) | .tdd-plan.md + .reinjection.md + test files + feedback | Fixed production code |
| **Validator** | .tdd-plan.md | Verdict report |
| **Reviewer** | .tdd-plan.md | Review report |
| **Lorekeeper** | .session-note.md (if continuing), config.md | .session-note.md updates |
| **Librarian** | .session-note.md, config.md | KB files, cleared .session-note.md |

---
name: scaffold
description: >
  Knowledge of the scaffold CLI — a ticket access and criteria-stack
  management tool. Scaffold fetches Linear tickets, displays criteria-stack
  status, and manages the criteria stack (push, pop, list, clear). It no
  longer performs code generation, test writing, grounding, or TDD loops —
  those responsibilities have migrated to review-cli (grounding and
  validation) and the agent's own editing tools (test and implementation
  writing). Use when questions relate to fetching Linear tickets, inspecting
  or manipulating the criteria stack, or the .scaffold/ state files.
---

# scaffold — Ticket Access & Criteria-Stack Management

Scaffold is a lightweight CLI for two things:

1. **Fetching Linear tickets** — retrieve a ticket by identifier and print
   its rendered markdown.
2. **Managing the criteria stack** — a local, file-backed stack of criterion
   frames that tracks which acceptance criteria are pending for a ticket.

Scaffold does **not** write tests, implement code, narrow plans, run
validation gates, or drive a TDD loop. Those responsibilities now belong to
`review-cli` (grounding checks and validation) and the agent's own editing
tools (test and implementation writing).

## Entry point

```
scaffold <command> [args...]
scaffold --help              # list all commands
scaffold <command> --help    # command-specific options
```

Three commands:

```
scaffold fetch-ticket <ticket-id>   # Fetch and print a Linear ticket
scaffold status                     # Show ticket and criteria stack status
scaffold stack <subcommand>         # Manage criteria stack operations
```

## Command: fetch-ticket

```
scaffold fetch-ticket <ticket-id>
```

Fetches a Linear ticket by its human-readable identifier (e.g. `SA-456`)
and prints rendered markdown to stdout. The output includes a metadata
table (state, priority, assignee, labels, dates, URL) and the ticket's
description.

### API key

The Linear API key is read from `~/.secrets/linear-key` (a plain text file
containing the key).

### Output format

```
# SA-456 — Ticket title

| Field    | Value |
|----------|-------|
| State    | In Progress |
| Priority | High |
| Assignee | Jane Doe |
| Labels   | bug, backend |
| Created  | 2025-01-15 |
| Updated  | 2025-01-20 |
| URL      | https://linear.app/... |

## Description

[ticket description markdown]
```

### Errors

- Ticket not found → stderr message, exit 1
- HTTP error → `HTTP <code>: <body>` on stderr, exit 1

## Command: status

```
scaffold status
```

Shows the top of the criteria stack — the currently active ticket and
criterion. No arguments.

### Output (stack has frames)

```
Ticket: SA-1
Criteria remaining: 3

Current criterion:
- [pending | ticket] - [ ] First criterion text
```

### Output (stack empty)

```
No active ticket. Stack is empty.
```

## Command: stack

```
scaffold stack <subcommand> [options]
```

Manages the criteria stack. Four subcommands:

### stack list

```
scaffold stack list
```

Prints the full stack as a JSON array (newest first / top of stack at
index 0). Each frame is an object with these fields:

```json
[
  {
    "ticket": "SA-1",
    "criterion": "- [ ] First",
    "status": "pending",
    "origin": "ticket",
    "plan_context": ""
  }
]
```

### stack push

```
scaffold stack push --ticket <id> --criterion <text> \
  [--status <status>] [--origin <origin>] [--plan-context <context>]
```

Pushes a new criterion frame onto the top of the stack (index 0).

| Flag | Required | Default | Description |
|------|----------|---------|-------------|
| `--ticket` | yes | — | Ticket id (e.g. `SA-123`) |
| `--criterion` | yes | — | Criterion text (typically a `- [ ] ...` checkbox bullet) |
| `--status` | no | `pending` | Frame status |
| `--origin` | no | `ticket` | Frame origin |
| `--plan-context` | no | `""` | Optional context string |

Output: `Pushed 1 frame.`

### stack pop

```
scaffold stack pop
```

Removes and prints the top frame as a JSON object. If the stack is empty,
prints `Stack is empty.`

### stack clear

```
scaffold stack clear
```

Removes all frames from the stack. Output: `Stack cleared.`

## CriterionFrame fields

Every frame on the stack has these fields:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `ticket` | string | *(required)* | Linear ticket identifier |
| `criterion` | string | *(required)* | The acceptance criterion text |
| `status` | string | `pending` | Current state of the criterion |
| `origin` | string | `ticket` | Where the criterion came from |
| `plan_context` | string | `""` | Optional context for implementation |

## State files

All state lives under `.scaffold/` in the current working directory:

| File | Purpose |
|------|---------|
| `.scaffold/.criteria-stack.json` | The criteria stack — a JSON array of `CriterionFrame` objects, top of stack at index 0 |
| `.scaffold/.criteria-stack.lock` | File lock for concurrent access safety |

### Stack file format

The stack file is a JSON array. The first element (index 0) is the top of
the stack (the currently active criterion). Frames are pushed to the front
and popped from the front.

```json
[
  {"ticket": "SA-1", "criterion": "- [ ] Second", "status": "pending", "origin": "ticket", "plan_context": ""},
  {"ticket": "SA-1", "criterion": "- [ ] First", "status": "pending", "origin": "ticket", "plan_context": ""}
]
```

### Concurrency safety

Stack operations use file locking (`fcntl` on Unix, `msvcrt` on Windows)
to prevent concurrent modification. Writes are atomic (temp file + rename
with `fsync`).

### Validation on load

When the stack file is loaded, each entry is validated:
- Must be a JSON object
- Must have string `ticket` and `criterion` fields (non-empty after trim)
- Optional fields (`status`, `origin`, `plan_context`) must be strings if
  present

Invalid entries raise `ValueError` with a descriptive message.

## What scaffold does NOT do

The following capabilities have been removed from scaffold and migrated to
other tools:

| Former capability | Now handled by |
|-------------------|----------------|
| Test writing (WRITE_TEST phase) | Agent (`edit`/`write` tools) |
| Implementation (AWAIT_IMPL phase) | Agent (`edit`/`write` tools) |
| Code generation | Agent (`edit`/`write` tools) |
| Plan narrowing / grounding | `review-cli` + agent |
| Ticket validation gate | `review-cli` |
| Code review | `review-cli` |
| Pipeline state machine | *(removed — no state machine)* |
| push-ticket, next-step, review-ticket | *(removed — use `stack push` instead)* |
| .tdd-plan.md, .gap-plan.md, .pipeline-log.jsonl | *(removed)* |

Scaffold is now a thin ticket-access and stack-management layer. The
criteria stack is a simple data structure — there is no phase machine,
no automatic phase transitions, and no AI-driven workflow inside scaffold.

## Relationship to review-cli and the agent

The tools form a divided workflow:

| Tool | Role |
|------|------|
| `scaffold` | Fetch tickets, manage the criteria stack (what to work on) |
| Agent (`edit`/`write`) | Write tests and implementation code (do the work) |
| `review-cli` | Grounding checks and code review (verify the work) |

A typical workflow might be:

1. `scaffold fetch-ticket SA-42` — read the ticket
2. `scaffold stack push --ticket SA-42 --criterion "- [ ] Add cache invalidation"` — queue a criterion
3. Use `review-cli` to ground the criterion against the codebase
4. Agent writes the test and implementation using `edit`/`write`
5. Use `review-cli` to review the diff
6. `scaffold stack pop` — criterion is done, remove it from the stack
7. `scaffold status` — check what's next

Scaffold tracks the list of work; review-cli verifies it; the agent does the
work directly. See the `tdd` skill (`/skill:tdd`) for the full TDD workflow
that orchestrates all three together.
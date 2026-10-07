---
name: tdd
description: >
  Orchestrate a ticket-driven TDD workflow using scaffold (ticket sourcing
  and criteria stack) and review-cli (grounding checks and ticket
  validation). The agent writes tests and implementation directly using its
  editing tools, with review-cli providing independent verification at each
  step. For each acceptance criterion: run a grounding check via review-cli
  against the full repository state, synthesize test guidance, write a red
  test, run an implementation grounding check, implement to green, then pop
  and advance. When the stack is empty, run a final full ticket validation
  via review-cli. Use when the user wants to work through a ticket's
  acceptance criteria with a structured red-green TDD cycle.
---

# tdd — Ticket-Driven TDD Workflow

This skill orchestrates a red-green TDD cycle across two CLI tools and the
agent's own editing capability:

| Tool | Role in the workflow |
|------|----------------------|
| `scaffold` | Source tickets, manage the criteria stack (push/pop/list/status) |
| `review-cli` | Grounding checks (is the criterion already satisfied? what needs to change?) and final ticket validation |
| Agent (edit/write) | Write tests and implementation code directly, guided by grounding findings |

The agent acts as both orchestrator and implementer: it runs review-cli for
independent grounding, reads the findings, synthesizes guidance, and writes
code directly. The user can choose at each step whether to let the agent
write the code or implement manually with agent guidance.

review-cli provides **independent verification** that the agent cannot
replicate on itself — the review agent has no knowledge of what the driving
LLM intended, so it reviews the code objectively with its own exploration of
the repository.

## When to use this skill

Load this skill when the user wants to:

- Work through a Linear ticket or local ticket via a structured TDD cycle
- Implement acceptance criteria one at a time with red-green verification
- Use review-cli to ground each criterion against the actual codebase
- Run a final validation pass over all changes

Do **not** use this skill when:
- The user only wants a code review (use `review-cli` directly)
- The user only wants to fetch a ticket or check stack status (use `scaffold` directly)

## Prerequisites

- `scaffold` and `review-cli` on PATH
- A git repository for the target project (review-cli requires a git repo)
- API keys set for the chosen model provider (e.g. `OPENAI_API_KEY`, `OLLAMA_API_KEY`, etc.)
- The agent should load the `review` skill for detailed flag references
  and result protocols: `/skill:review`

## Workflow overview

```
Phase 0: Source ticket → extract criteria → push onto stack
    ↓
Phase 1: Per-criterion loop (while stack non-empty)
    ┌──────────────────────────────────────────────────┐
    │ 1. Read top criterion (scaffold status)           │
    │ 2. Grounding check: review-cli (full repo, criterion) │
    │ 3. If APPROVED → already satisfied, pop & continue  │
    │ 4. Synthesize test guidance from findings            │
    │ 5. Write red test (agent edits or user implements)   │
    │ 6. Run test → confirm RED                            │
    │ 7. Implementation grounding: review-cli              │
    │ 8. Synthesize implementation guidance                │
    │ 9. Implement (agent edits or user implements)        │
    │ 10. Run test → confirm GREEN                         │
    │ 11. Pop criterion, loop to next                      │
    └──────────────────────────────────────────────────┘
    ↓
Phase 2: Stack empty → final ticket validation via review-cli
```

## Phase 0: Ticket sourcing and stack setup

### From Linear

Fetch the ticket to read its description and acceptance criteria:

```bash
scaffold fetch-ticket <ticket-id>
```

The output includes the ticket description (which should contain an
`## Acceptance Criteria` section with `- [ ] ...` checkbox bullets).

Extract each `- [ ] ...` bullet as a distinct criterion.

### From local context

If the user provides a ticket description directly (e.g. pasted text,
a local markdown file), extract the acceptance criteria from the
`## Acceptance Criteria` section. Each `- [ ] ...` bullet is one criterion.

If no structured criteria section exists, work with the user to define
3–7 independently testable criteria before proceeding.

### Pushing criteria onto the stack

The stack is **LIFO** — the last criterion pushed is the first one popped.
Push criteria in **reverse dependency order** so the first criterion to
work on ends up on top:

```bash
# Push last criterion first (it sinks to the bottom)
scaffold stack push --ticket <ticket-id> --criterion "- [ ] Last criterion"
# ...
# Push first criterion last (it's on top)
scaffold stack push --ticket <ticket-id> --criterion "- [ ] First criterion"
```

Verify the stack:

```bash
scaffold stack list
scaffold status
```

### Capture the base commit

Before starting any work, capture the current HEAD. This is used as the
`--base-ref` for the final ticket validation in Phase 2:

```bash
git rev-parse HEAD > /tmp/tdd-base-commit.txt
```

## Phase 1: Per-criterion TDD loop

Repeat this loop while `scaffold stack list` returns a non-empty array.

### Step 1: Read the top criterion

```bash
scaffold status
```

This shows the ticket ID, criteria remaining, and the current (top)
criterion text. Read it and proceed.

### Step 2: Grounding check via review-cli

Run review-cli against the **full repository state** with the criterion
as requirements. This determines whether the criterion is already
satisfied and, if not, what needs to change:

```bash
review-cli run --repository . \
  --base-ref :empty \
  --head-ref :working \
  --requirements "<criterion text>" \
  --emit-events
```

**Why `:empty` → `:working`:** The `:empty` base ref means the entire
repository is the diff. The `:working` head ref includes uncommitted
changes (tests and implementation written during this cycle). This gives
the review agent full visibility into the codebase.

**`--requirements` accepts inline text:** If the string is a file path
that exists, review-cli reads the file. Otherwise it uses the string
directly as the requirements text. For long criteria, either form works.

**Budget:** Grounding checks should be fast. Consider limiting turns:
`--max-turns 8 --wall-clock-budget-secs 60`

### Step 3: Assess the grounding result

Parse the JSON result from review-cli's stdout. See the `review` skill
for the full `review.result/v1` protocol. The key fields are:

| `status` | `reason` | Action |
|-----------|----------|--------|
| `APPROVED` | `REVIEW_COMPLETED` | Criterion already satisfied → pop and continue to next |
| `CHANGES_REQUESTED` | `REVIEW_COMPLETED` | Findings describe what needs to change → proceed to Step 4 |
| `INDETERMINATE` | any | Review could not complete → retry with higher budget, or fall back to manual assessment |

**Exit code shortcut:** review-cli exits 0 for APPROVED, 1 for
CHANGES_REQUESTED, 3 for INDETERMINATE. You can check `$?` before parsing
JSON if you just need the verdict.

### Step 4: Synthesize test guidance

Read the findings from the grounding check. Each finding has:

```json
{
  "blocking": true,
  "message": "Missing input validation in process_request()",
  "severity": "high",
  "path": "src/handler.rs",
  "line": 42,
  "recommendation": "Add bounds check before accessing request.body"
}
```

Synthesize test guidance by combining:
- **The findings** — what's missing or wrong (the `message` and `recommendation` fields)
- **The criterion text** — what behavior should be verified
- **The referenced source files** — read the files at the `path` values
  from the findings to understand the current code

Present the guidance to the user:

1. **What the test should verify** — the observable behavior described by
   the criterion, grounded in the findings
2. **Which files are involved** — from the findings' `path` fields
3. **What the current code looks like** — relevant sections of the
   referenced files
4. **Suggested test approach** — test function name, inputs, assertions,
   and expected failure mode

### Step 5: Write the red test

Offer the user two paths:

#### Manual path

Present the guidance from Step 4. The user writes the test themselves.
The agent remains available to answer questions, suggest alternatives,
and review the test before verification.

#### Agent path (default)

The agent writes the test directly using its `edit` and `write` tools.
Before writing, the agent must **read the target file** (or confirm it
doesn't exist yet) to understand the current state and test patterns.

- **For a new test file:** Use `write` to create it with the full test
  content.
- **For an existing test file:** Read it first, then use `edit` to add
  the new test function or modify existing tests.

The agent should follow existing test patterns in the project (framework,
naming conventions, assertion style, imports/fixtures). Read neighboring
test files to match conventions.

### Step 6: Verify the test is red

Run the test using the project's test runner. The agent should determine
the appropriate test command from the project's configuration:

```bash
# Rust
cargo test --test <test-name> -- --nocapture

# Python
pytest tests/test_handler.py::test_function -v

# Node/TypeScript
npx jest tests/handler.test.ts

# Go
go test ./tests/... -run TestFunction -v
```

**Expected outcome:** The test **fails** (red). If the test passes
immediately (green without implementation), either:
- The criterion is already satisfied (go back to Step 3 — did the
  grounding check miss this?)
- The test is weak (doesn't actually verify the criterion)
- The test has a bug (false positive)

If the test fails for the **wrong reason** (e.g. compilation error,
import error, not an assertion failure), fix the test infrastructure
first.

### Step 7: Implementation grounding check via review-cli

Now that the red test exists, run another grounding check. This time the
review includes the test file, which helps the review agent understand
exactly what behavior is expected:

```bash
review-cli run --repository . \
  --base-ref :empty \
  --head-ref :working \
  --requirements "<criterion text>. Test expectation: <test file path> must pass after implementation." \
  --emit-events
```

The findings from this check should focus on **what production code needs
to change** to make the test pass, not on the test itself.

### Step 8: Synthesize implementation guidance

Combine the findings from Step 7 with:
- **The red test** — read the test file to see exactly what it asserts
- **The failing test output** — from Step 6, showing why the test fails
- **The referenced production files** — read the files at the findings'
  `path` values

Present the guidance:

1. **What the test expects** — the specific assertions and expected values
2. **Why the test currently fails** — from the red test output
3. **Which production files need to change** — from the findings
4. **What the current code looks like** — relevant sections
5. **Suggested approach** — based on the findings, test expectations,
   and existing code patterns

### Step 9: Implement

Offer the user two paths (same as Step 5):

#### Manual path

Present the guidance from Step 8. The user implements the change.
The agent reviews the implementation before verification.

#### Agent path (default)

The agent implements the change directly using its `edit` and `write`
tools. Before writing, the agent must **read each target file** to
understand the current code and match existing patterns.

- **For modifying an existing file:** Read it first, then use `edit`
  with targeted text replacements.
- **For creating a new file:** Use `write` with the full file content.
- **For multi-file changes:** The agent can coordinate changes across
  multiple files in sequence, reading each before editing.

The agent should follow existing code patterns in the project (style,
naming, error handling, imports).

### Step 10: Verify the test is green

Run the same test command from Step 6:

```bash
<test-command> <test-file> -v
```

**Expected outcome:** The test **passes** (green). If it still fails:
- Read the new failure output
- Determine whether the implementation is incomplete or wrong
- Fix the issue (agent edits or user implements)
- Repeat Steps 9–10 until green

**Edge case — test passes but for wrong reason:** If the test passes but
the implementation seems wrong, run a broader test suite to check for
regressions:

```bash
cargo test  # or pytest, npm test, etc.
```

### Step 11: Pop the criterion and loop

Once the test is green:

```bash
scaffold stack pop
```

This removes the completed criterion from the top of the stack. Then:

```bash
scaffold status
```

If the stack is non-empty, loop back to **Step 1** with the next criterion.
If the stack is empty, proceed to **Phase 2**.

## Phase 2: Ticket validation

When the criteria stack is empty, all criteria have been implemented and
verified individually. Run a final full validation using review-cli
against the complete diff of all changes:

```bash
BASE=$(cat /tmp/tdd-base-commit.txt)
review-cli run --repository . \
  --base-ref "$BASE" \
  --head-ref :working \
  --requirements "<all criteria text>" \
  --emit-events \
  --max-turns 20 \
  --wall-clock-budget-secs 120
```

**Why `--base-ref "$BASE"`:** The base commit captured in Phase 0 is the
state before any work started. The diff from base to working tree includes
all changes made for this ticket.

**Why higher budget:** The final validation reviews the full diff, which
may be large. Give the review agent more turns and time.

### Interpreting validation results

| `status` | Action |
|----------|--------|
| `APPROVED` | Ticket is complete — all changes reviewed and approved |
| `CHANGES_REQUESTED` | Read findings, address each one (may require returning to Phase 1 for new criteria), then re-validate |
| `INDETERMINATE` | Review couldn't complete — retry with higher budget, or review manually |

If `CHANGES_REQUESTED`, the findings describe issues with the overall
change set. For each finding:
1. Determine if it maps to an existing criterion (already addressed) or
   a new issue
2. If new, push it as a new criterion: `scaffold stack push --ticket <id> --criterion "<finding message>"`
3. Return to Phase 1 for the new criteria
4. Re-run Phase 2 validation when the stack is empty again

### Commit and create a pull request

Once validation passes (`APPROVED`), commit the changes on a feature
branch and create a pull request:

```bash
# Create a feature branch (if not already on one)
git checkout -b ticket/<ticket-id>

# Stage and commit the changes
git add -A
git commit -m "$(scaffold fetch-ticket <ticket-id> | head -1 | sed 's/# //')"

# Push the branch and create a pull request
git push -u origin ticket/<ticket-id>
gh pr create --title "$(scaffold fetch-ticket <ticket-id> | head -1 | sed 's/# //')" \
  --body "Implemented via TDD workflow. All acceptance criteria verified green and review-cli validation passed."
```

Do not push directly to `main` or `master`. Always work on a feature branch
and create a PR for review.

## Review-cli invocation patterns

### Grounding check (per criterion, before test)

```bash
review-cli run --repository . \
  --base-ref :empty --head-ref :working \
  --requirements "<criterion text>" \
  --emit-events --max-turns 8 --wall-clock-budget-secs 60
```

Full repo as diff. Determines if the criterion is already satisfied and
what needs to change.

### Implementation grounding (per criterion, after red test)

```bash
review-cli run --repository . \
  --base-ref :empty --head-ref :working \
  --requirements "<criterion text>. Test: <test-file> must pass." \
  --emit-events --max-turns 8 --wall-clock-budget-secs 60
```

Same as above but includes the test file in the working tree. Focuses on
what production code needs to change.

### Final ticket validation

```bash
review-cli run --repository . \
  --base-ref <base-commit> --head-ref :working \
  --requirements "<all criteria>" \
  --emit-events --max-turns 20 --wall-clock-budget-secs 120
```

Reviews the full diff of all changes. Higher budget for larger diffs.

## Interpreting review-cli results

Parse stdout as JSON (`review.result/v1`). Key decisions based on `status`:

| Exit code | Status | Meaning |
|-----------|--------|---------|
| 0 | `APPROVED` | No blocking findings — criterion satisfied / changes approved |
| 1 | `CHANGES_REQUESTED` | Blocking findings — work needed |
| 2 | *(error)* | Invalid request — check error JSON |
| 3 | `INDETERMINATE` | Review could not complete — retry or manual |
| 5 | *(cancellation)* | Ctrl-C was pressed |

Findings array — each finding has `blocking`, `message`, `severity`,
`path`, `line`, `recommendation`. Use `path` and `line` to locate the
relevant code. Use `recommendation` for implementation guidance.

## Practical notes

### Stack ordering

The criteria stack is LIFO. Push criteria in reverse dependency order so
the first criterion to work on is on top. If criteria are independent,
order doesn't matter.

### Read before write

The agent must read a file before editing it. This is both a discipline
rule (understand the current code and patterns before changing them) and
a practical requirement (the `edit` tool needs to match existing text).
For new files, use `write` to create them.

### Test runner detection

The agent should determine the project's test runner from its configuration:
- `Cargo.toml` → `cargo test`
- `pyproject.toml` / `pytest.ini` → `pytest`
- `package.json` → `npm test` or `npx jest`
- `go.mod` → `go test`
- No config → ask the user

### Model and budget selection

- **Grounding checks:** Use a fast, capable model with a low budget (8
  turns, 60 seconds). The goal is a quick assessment, not an exhaustive
  review.
- **Final validation:** Use a capable model with a higher budget (20 turns,
  120 seconds) for thorough review of the full diff.

### Error recovery

| Situation | Recovery |
|-----------|----------|
| review-cli INDETERMINATE | Retry with `--max-turns 15 --wall-clock-budget-secs 120`. If still indeterminate, manually inspect the codebase. |
| Test fails for wrong reason | Check for compilation/import errors before assertion failures. Fix test infrastructure first. |
| Test green but shouldn't be | Verify the test actually asserts the expected behavior. Check for mocking/stubbing that bypasses the real code. |
| Edit fails (text not found) | Re-read the file — it may have changed. Use the current content to find the correct text to replace. |
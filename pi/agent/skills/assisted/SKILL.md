---
name: assisted
description: >
  Guide the user through manual implementation of scaffold criteria. The AI
  writes tests and verifies green; the user implements with AI guidance. Use
  when the user wants to make code changes themselves with AI assistance rather
  than having scaffold's AI implement automatically. The agent reads pipeline
  state, explains what each test expects, identifies files to change, suggests
  approaches, and reviews the user's implementation before verification.
---

# assisted — AI-Guided Manual Implementation

In this workflow, scaffold's AI handles test-writing and verification; the
*user* handles implementation. The agent acts as a pair-programmer: reading
the pipeline state and codebase to provide targeted guidance at each pause,
then running scaffold's verification to confirm the implementation is correct.

This is the alternative to `via-scaffold` (where scaffold's AI writes both
tests and implementation). Use this skill when the user says they want to
implement changes themselves, wants to avoid the AI implementation loop's
downtime, or wants more control over the implementation approach.

## Prerequisites

- `scaffold` on PATH.
- A target repo with a `.dev-pipeline.toml` (set `git_workflow = true` for
  branches/PRs). The repo must be the current working directory or passed as
  `repo_path` to `scaffold_run`.
- A Linear ticket ID or a local ticket file (via `to-tickets` skill).

## The workflow

### Phase 1 — Setup

Push the ticket and write the first test:

```
scaffold_run(mode: "run", repo_path: <repo>, work_id: <ticket-id>,
             skip_implementation: true, continuous: true)
```

This pushes the ticket (plan + narrow + seed stack), runs WRITE_TEST for the
first criterion, and pauses in AWAIT_IMPL because `skip_implementation` is
true. The result includes `stackTopFrame` (the current criterion's frame)
and `lastLog` (the pause output with test names and red test output).

If the ticket doesn't exist in Linear yet, use the `to-tickets` skill first
to create a local ticket file, then push it via `scaffold push-ticket
--ticket-file-in <path>` before resuming with `scaffold_run(mode: "resume", ...)`.

### Phase 2 — Guidance loop (per criterion)

After each scaffold_run pause, the agent provides guidance by reading the
pipeline state directly:

1. **Read the current frame.** Check `stackTopFrame` in the `scaffold_run`
   result first — if the tool populates it, use it directly. If
   `stackTopFrame` is null, fall back to reading `.scaffold/.criteria-stack.json`
   (or the repo's criteria stack file) to get the current top frame:
   - `frame.criterion` — the acceptance criterion text (what must be true)
   - `frame.plan_context` — the implementation plan's guidance for this
     criterion (which files to change, what approach, constraints)
   - `frame.test_files` / `frame.test_names` — where the failing test lives
   - `frame.status` — should be `"test-written"` (paused for implementation)
   - `frame.origin` — `"ticket"`, `"validate-missed"`, or `"review"`

2. **Read the test file** (`frame.test_files[0]`) to see the actual test code.
   This is the specification — it shows exactly what the implementation must
   do. Show the relevant test function(s) to the user.

3. **Read `frame.plan_context`** for implementation guidance. This contains
   the narrowed plan's specific lines about this criterion: which files to
   modify, what approach to take, and what constraints to respect. Present
   this to the user as structured guidance.

4. **Identify referenced production files.** Use the same heuristic as
   scaffold's `extract_referenced_paths`: look for backtick-quoted paths in
   the criterion and plan_context, and check which ones exist as files. Read
   the relevant sections of these files and show the user the current code
   that needs to change.

5. **Synthesize guidance.** Present a concise, actionable summary:
   - What the test expects (the behaviour the test asserts)
   - Why the test currently fails (from the red test output in `lastLog`)
   - Which files the plan says to modify
   - What the current code looks like at those locations
   - A suggested approach (based on the plan context, the test expectations,
     and the existing code patterns)

6. **Wait for the user to implement.** The user makes the code changes
   themselves. The agent remains available to answer questions, suggest
   alternatives, review the user's changes, and explain error messages.

7. **Verify.** Once the user says they're done (or asks to verify), run:

   ```
   scaffold_run(mode: "resume", repo_path: <repo>, work_id: <ticket-id>,
                skip_implementation: true, continuous: true)
   ```

   This re-runs the scoped tests for the current criterion:
   - **Still red** → scaffold pauses again at the same criterion. Read the
     updated `lastLog` for the new red output, explain what's still wrong,
     and let the user try again.
   - **Green** → scaffold pops the criterion and, because `continuous: true`,
     cascades through to the next criterion's WRITE_TEST and pauses again.
   - **Done** → all criteria are satisfied. Scaffold automatically runs
     TICKET_VALIDATE.

### Phase 3 — Ticket validation

When the last criterion pops, `scaffold_run` with `continuous: true` cascades
into TICKET_VALIDATE automatically. This runs the complete ticket-validation
gate:

1. **Re-narrow** — fetch the ticket again, regenerate the plan, and narrow it
   against the current codebase as a safety net for missed criteria.
2. **Lint** — run the configured format and lint checks.
3. **Full test suite** — run the entire test suite, not only the scoped tests.
4. **Smoke test** — run the configured smoke command, when one is configured.
5. **Code review** — have the AI review all changed files against the original
   plan.

If validation finds issues, scaffold pushes new criteria from the re-narrow or
code review and pauses. Continue the guidance loop for those criteria. If the
review returns `APPROVED`, the sentinel is removed and the ticket is done.

## What to show the user at each pause

At every AWAIT_IMPL pause, present:

1. **Criterion** — the acceptance criterion text verbatim from the frame.
2. **Test specification** — the actual test code from `frame.test_files[0]`.
3. **Plan context** — the untruncated `frame.plan_context`.
4. **Current code** — relevant sections of the production files named in the
   plan context.
5. **Red test output** — from `lastLog`; if it is unavailable, read
   `.scaffold/.pipeline-log.jsonl` or parse the command output.
6. **Suggested approach** — synthesized from the criterion, test, plan, code,
   and failure output.

Keep the guidance concise and actionable. The goal is to minimize context
switching: everything needed to implement should be in one place.

## Edge cases

### `green-unconfirmed` status

The test passed without implementation for a criterion originating from
`validate-missed` or `review`. Explain that the test may be weak. If the user
confirms the behaviour is genuinely already present, run
`scaffold_run(mode: "resume", accept_green: true, ...)` to accept and advance.

### `nothing-written` status

The Tester AI wrote no test files. Read the criterion and codebase to assess
whether it is already satisfied. If it is, run with `accept_no_test: true`; if
not, investigate why the tester produced nothing.

### `validating` status

Ticket validation is in progress. Let `scaffold_run` complete and report the
result. If validation fails, read the error and guide the user through fixing
it.

### `feedback-ready` status

Feedback has been queued via `scaffold give-feedback`. Run
`scaffold_run(mode: "resume", ...)` to apply it, or use
`scaffold_run(mode: "feedback", feedback_text: "...", ...)` to queue feedback
and resume.

### Direct-strategy criteria

Criteria tagged `strategy: direct` or `strategy: manual` support
`--skip-implementation`. The direct strategy pauses with a guidance view
instead of running the AI implementor. Because direct-strategy criteria have
no test, show the criterion, untruncated plan context, and referenced file
paths. After the user implements, `scaffold next-step` runs `recheck()`, which
checks whether referenced files appear in git changes. `--accept-manual`
overrides the git-changes floor check.

### Manual-verification criteria

Criteria tagged `verification: manual` (documentation, config, and CI changes)
skip WRITE_TEST/AWAIT_IMPL. Show the criterion, plan context, and referenced
files. After the user makes the change, scaffold checks whether the referenced
files appear in git changes.

## Difference from via-scaffold

| | via-scaffold | assisted |
|---|---|---|
| Who writes code | scaffold's AI | the user |
| Agent role | drives scaffold_run to completion | guides the user between phases |
| scaffold_run flags | `skip_implementation: false` (default) | `skip_implementation: true` |
| Interaction model | fire-and-forget or progress reports | pause-guidance-implement-verify loop |
| When to use | “make this change” | “I want to make this change with AI guidance” |

## Key scaffold_run parameters

| Parameter | Value | Why |
|---|---|---|
| `mode` | `"run"` first, `"resume"` thereafter | Push once, then advance |
| `skip_implementation` | `true` | Pause for manual implementation |
| `continuous` | `true` | Cascade to the next criterion after verification |
| `accept_green` | `true` only for green-unconfirmed | Accept an already verified test |
| `accept_manual` | `true` only for manual verification | Accept a manual criterion |
| `accept_no_test` | `true` only for nothing-written | Accept when no test was written |

## Pipeline state files to read

| File | What to read | When |
|---|---|---|
| `.scaffold/.criteria-stack.json` | Current frame: criterion, plan_context, test_files, test_names, status, origin | At every pause |
| `.scaffold/.gap-plan.md` | Full narrowed plan and criteria | For broader context |
| Test files (`frame.test_files[0]`) | Test code and expected behaviour | At every AWAIT_IMPL pause |
| Production files from `plan_context` | Current code to change | At every AWAIT_IMPL pause |
| `lastLog` from scaffold_run | Red test output and pause messages | At every pause |

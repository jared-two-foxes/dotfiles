---
name: scaffold
description: >
  Knowledge of the ticket-pipeline TDD code generation tool — the `scaffold` CLI
  and its subcommands (push-ticket, next-step, review-ticket,
  propose-ticket-edit, split-ticket,
  create-child-tickets, update-ticket, reset-pipeline, list-models, bench),
  the criteria-stack state machine and its phases (WRITE_TEST, AWAIT_IMPL,
  TICKET_VALIDATE, etc.), and pipeline state files (.criteria-stack.json,
  .tdd-plan.md, .gap-plan.md, .dev-pipeline.toml, .declined-criteria.json,
  .pipeline-log.jsonl). Use when questions relate to the TDD pipeline, the
  criteria stack, scaffold commands, pipeline workflow or state files, or the
  relationship between ticket-pipeline and the prompts/ directory.
---

# scaffold — Ticket-Pipeline TDD Tool

A Linear-ticket-driven TDD pipeline. It fetches tickets from Linear, plans
and narrows them against the actual codebase, then drives a per-criterion
red-green cycle: write a failing test, pause for implementation, detect
green mechanically, repeat — until every acceptance criterion is satisfied,
at which point a full ticket-validation gate runs (re-narrow, lint, full
test suite, smoke, code review).

## Entry Point

All commands are invoked via the `scaffold` dispatcher:

```
scaffold <command> [args...]
scaffold --help              # list all commands grouped by category
scaffold <command> --help    # command-specific options
```

`pip install -e .` from the ticket-pipeline source registers `scaffold` as a
console script. Each subcommand forwards to a Python module's own `main()`;
`scaffold <name> --help` shows that subcommand's real argparse flags.

## The Core TDD Loop

The everyday workflow is two gestures, run repeatedly:

```
scaffold push-ticket <ticket-id>    # 1. seed the criteria stack
scaffold next-step                  # 2. write a test, implement, or re-check/pop
scaffold next-step --continuous     #    optional: keep going until human input is required
```

Step 2 repeats for each acceptance criterion. When the last criterion for
a ticket is popped, `next-step` automatically runs `TICKET_VALIDATE` — no
separate command needed.

## Command Reference

### Ticket Review (manual, situational)

| Command | Description |
|---|---|
| `review-ticket <id>` | Check a ticket's claims against the actual codebase. Read-only report saved to `.ticket-review-<id>.md`. Never rewrites the ticket. |
| `propose-ticket-edit <id>` | Rewrite a ticket to resolve review-ticket's flagged concerns. Output to `.ticket-proposed-<id>.md` by default. Never touches Linear. |

These commands are available for manual use on Linear tickets or when a ticket needs post-hoc correction. Ticket quality (review, context exploration, criteria verification) is handled upstream by the `to-tickets` or `planner` skills before any ticket reaches `push-ticket`.

### Seed & Run the Criteria Loop

| Command | Description |
|---|---|
| `push-ticket <id>` | Fetch a Linear ticket, run plan+narrow, seed `.criteria-stack.json` with one frame per remaining acceptance criterion. The criteria stack handles any number of criteria from a single ticket — splitting is not automatic. |
| `next-step` | Advance the criteria stack by exactly one phase. No ticket-id argument — reads from the stack itself. Re-run it to keep moving; `--continuous` keeps going until a genuine human-only pause. |

### Ticket Restructuring (manual — not part of push-ticket)

| Command | Description |
|---|---|
| `split-ticket <id>` | Assess a ticket for complexity and propose child tickets if too large. Standalone — never creates tickets in Linear itself. Saves
 report to `.ticket-split-<id>.md`. |
| `create-child-tickets <id>` | Turn split-ticket's proposed children into real Linear sub-issues. |
| `update-ticket <id>` | Push a locally revised ticket file back to the live Linear ticket. |

### Utilities

| Command | Description |
|---|---|
| `list-models` | List models available from the configured AI provider. |
| `reset-pipeline` | Clear `.criteria-stack.json` and all scratch files. Dry-run by default; `--yes` to execute. Never removes `.dev-pipeline.toml` or
 `.pipeline-log.jsonl`. |

### Advanced / Internal

| Command | Description |
|---|---|
| `copilot-login` | One-time device-flow OAuth for the GitHub Copilot provider. |
| `fetch-ticket <id>` | Fetch and render a single Linear ticket by id. |
| `bench` | Run a pipeline block N times per model and report pass-rate/cost. |
| `bench-block` | Run one pipeline block once against fixed fixtures (used by bench). |

## The Criteria-Stack State Machine

`.criteria-stack.json` is the pipeline's sole cross-invocation source of
truth — a JSON array of `CriterionFrame` objects. `next-step` reads the top
frame and dispatches based on its `status` field (re-detected fresh from
real state every step — status is a hint, never a trust boundary).

### Phase Dispatch (top frame)

```
stack empty                     → done, nothing to do
status == "validating"          → TICKET_VALIDATE (resume a crashed validation)
status == "green-unconfirmed"   → re-run scoped tests:
                                    any red    → normal AWAIT_IMPL (someone fixed it)
                                    all green,
                                      nothing unconfirmed    → done, POP
                                      some unconfirmed,
                                        --accept-green       → done, POP
                                        no --accept-green    → pause (exit 0)
verification == "manual" AND
  status in ("pending",
    "awaiting-manual-impl")     → MANUAL_CRITERION (no test — see below)
status == "pending"             → WRITE_TEST
status == "pending",
--manual-test passed            → MANUAL_TEST_GATE
                                   (skip Tester AI; use provided
                                    --manual-test-ref refs, or
                                    existing_test refs if present;
                                    run compile + scoped tests)
status == "test-written",
  missing test_files/test_names → WRITE_TEST (retry)
status == "test-written"        → re-run scoped tests:
                                    any red    → AWAIT_IMPL (always pauses)
                                    all green,
                                      nothing unconfirmed    → done, POP
                                      something unconfirmed  → green-unconfirmed
status == "done"                → POP
```

### POP → TICKET_VALIDATE

When POP removes the last frame for a ticket (or empties the stack),
`TICKET_VALIDATE` runs automatically:

1. **Sentinel frame** — a `"validating"` status frame is pushed first, so a
   crash mid-validation is resumable on the next `next-step` call.
2. **Re-narrow safety net** — fresh fetch + plan + narrow. If the re-narrow
   still finds unmet criteria, they're pushed as new frames (origin =
   `validate-missed`) instead of failing outright.
3. **Lint gate** — format check + lint check (toolchain-specific commands).
4. **Full test suite** — the entire test suite, not just scoped tests.
5. **Smoke test** — optional, only if `smoke_cmd` is configured in
   `.dev-pipeline.toml`.
6. **Code review** — AI reviews all changed files against the original plan.
   `APPROVED` → remove sentinel, ticket is done. `CHANGES REQUESTED` →
   review findings pushed as new frames (origin = `review`).

### Manual-Verification Criteria

Criteria tagged `verification: "manual"` (documentation, config, CI changes
— no meaningful red/green) skip WRITE_TEST/AWAIT_IMPL entirely. The
mechanical floor is whether the files named in the criterion/plan_context
actually appear in `git diff` / untracked files. A match pops immediately;
no match pauses. If no file can be identified, `--accept-manual` is required
to pop.

### Exit Codes (next-step)

- **0** — every human pause point (red test awaiting implementation, review
  findings pushed, stack empty). "Go implement something", not "something broke".
- **Non-zero** — genuine pipeline failure (compile error exhausted retries,
  lint/test-suite/smoke failure, unparseable review).

### Key Flags

| Flag | Command | Effect |
|---|---|---|
| `--continuous` | next-step | Advance through every automatable transition without pausing; stop only at genuine human input points. |
| `--accept-green` | next-step | Accept unconfirmed green tests (validate-missed/review origin criteria whose tests passed without implementation). |
| `--accept-manual` | next-step | Accept a manual-verification criterion as satisfied, overriding the git-changed-files floor check. |
| `--manual-test` | next-step | Use manually authored test(s) for the top pending test criterion instead of running the Tester AI. |
| `--manual-test-ref <file::qualified_test_name>` | next-step | Scoped test reference for `--manual-test`; repeatable. |
| `--model <id>` | most commands | AI model to use (default: `opencode:gpt-5.4-mini`). |
| `--config <path>` | next-step | Path to pipeline config (default: `.dev-pipeline.toml`). |
| `--max-attempts <n>` | next-step | Total implementation attempts, initial write + refines sharing one budget (default: 3). |
| `--force` | push-ticket | Abandon an in-progress stack for a different ticket; replace entirely. |
| `--prepend` | push-ticket | Insert a new ticket's frames ahead of an in-progress stack as a prerequisite; in-progress stack resumes after. |
| `--validate-only` | push-ticket | Skip fetch/plan/narrow; push a "validating" sentinel so the next `next-step` runs the full validation gate directly. |
| `--from-gap-plan` | push-ticket | Reuse existing `.gap-plan.md` instead of re-running plan+narrow. |
| `--ticket-file-in <path>` | review-ticket, propose-ticket-edit, push-ticket | Read ticket from a local file instead of fetching from Linear. |
| `--log-level <level>` | most commands | `trace`/`debug`/`info`/`warning`/`error`/`critical`. `debug` shows per-tool-call activity; `trace` adds raw
 request/response payloads. |

## CriterionFrame Fields

Each entry in `.criteria-stack.json` has:

| Field | Type | Description |
|---|---|---|
| `ticket` | str | Linear ticket ID, e.g. `"SA-42"` |
| `criterion` | str | Verbatim bullet from the gap plan, e.g. `"- [ ] ..."` |
| `plan_context` | str | Implementation Plan lines relevant to this criterion, extracted at push time |
| `test_files` | list[str] \| None | Set once the test-writer runs; parallel to `test_names`. Usually length 1. |
| `test_names` | str \| None | Fully-qualified test names, parallel to `test_files` |
| `status` | str | `"pending"` / `"test-written"` / `"green-unconfirmed"` / `"awaiting-manual-impl"` / `"done"` / `"validating"` |
| `origin` | str | `"ticket"` (initial push) / `"validate-missed"` (re-narrow found it) / `"review"` (code review found it) / `"ticket-validate"`
 (sentinel) |
| `verification` | str | `"test"` (default, red/green) / `"manual"` (no meaningful test) |
| `existing_test_refs` | list[str] | `"file::test_name"` references to existing tests this criterion modifies rather than creating new ones |
| `unconfirmed_tests` | list[str] | Subset of `test_names` currently green without implementation (origin != `"ticket"`, observed green at first
 WRITE_TEST). Only ever shrinks. |

### Origin-Based Trust

- **`origin == "ticket"`** — green-at-write-time is trusted unconditionally.
  One criterion's implementation can legitimately satisfy a sibling as a
  side effect.
- **Any other origin** (`validate-missed`, `review`) — green-at-write-time is
  NOT trusted. The test is recorded in `unconfirmed_tests` and requires
  `--accept-green` to pop, preventing a false-green → pop → re-validate →
  false-green infinite loop.

## Key Files

### Cross-Invocation State

| File | Role |
|---|---|
| `.criteria-stack.json` | The work queue. Sole source of truth across `next-step` invocations. Only `next-step` (and `push-ticket` at seed time) writes
 to it. |
| `.declined-criteria.json` | Ledger of criteria rejected by the mechanical grounding check (symbols/tokens in the criterion that don't exist in the
 codebase). Append-only; makes declines sticky across runs. |
| `.dev-pipeline.toml` | Project-local build/test/lint command overrides. Your configuration, not pipeline output — `reset-pipeline` never removes it. |
| `.pipeline-log.jsonl` | Diagnostic event log. Never removed by reset. |

### Transient Scratch (regenerated fresh, never trusted across runs)

| File | Role |
|---|---|
| `.ticket.md` | Ticket text fetched from Linear |
| `.tdd-plan.md` | Implementation plan (AI-generated) |
| `.gap-plan.md` | Narrowed plan with remaining acceptance criteria |
| `.ticket-review-<id>.md` | review-ticket report |
| `.ticket-proposed-<id>.md` | propose-ticket-edit output |
| `.ticket-split-<id>.md` | split-ticket report |
| `.ticket-children-<id>.json` | create-child-tickets manifest |

## Configuration: .dev-pipeline.toml

Overrides the auto-detected toolchain's default commands. Keys:

| Key | Role |
|---|---|
| `build_cmd` | Compile/build the project |
| `test_compile_cmd` | Compile tests without running them |
| `test_cmd` | Run the full test suite |
| `test_filter_cmd` | Run a scoped test by name (`{filter}` is substituted with the qualified test name) |
| `fmt_fix_cmd` | Auto-fix formatting |
| `clippy_fix_cmd` | Auto-fix lint issues |
| `fmt_check_cmd` | Check formatting without fixing |
| `clippy_cmd` | Run lint checks |
| `smoke_cmd` | Optional smoke test command (if unset, smoke gate is skipped) |

### Auto-Detected Toolchains

Detection by marker file at project root (first match wins):

| Priority | Toolchain | Marker(s) | Notes |
|---|---|---|---|
| 1 | Bazel | `WORKSPACE`, `WORKSPACE.bazel`, `MODULE.bazel` | Takes priority (monorepo wrapping) |
| 2 | Rust (cargo) | `Cargo.toml` | Default fallback if nothing detected |
| 3 | CMake/ctest | `CMakeLists.txt` | |
| 4 | SvelteKit (npm) | `svelte.config.js`, `svelte.config.ts` | More specific than generic TS |
| 5 | TypeScript/Node (npm) | `package.json` | Generic fallback |

## The prompts/ Directory

The pipeline's AI steps (plan, narrow, test-criterion, implement-criterion,
review, etc.) are driven by prompt templates in a `prompts/` directory that
lives as a sibling of the `ticket-pipeline/` source tree. Each `.prompt.md`
file contains the role/steps/rules body injected into the model's prompt.
Loaded fresh on every run by `pipeline_lib.load_prompt_body()`.

Key prompt files:

| File | Drives |
|---|---|
| `plan.prompt.md` | The planning step (full implementation plan from ticket) |
| `narrow-plan.prompt.md` | The narrowing step (gap plan: what's left to do) — also tags `verification: manual` and `existing_test:` refs |
| `test-criterion.prompt.md` | WRITE_TEST phase (write a failing test for one criterion) |
| `implement-criterion.prompt.md` | next-step's implementation phase (make the failing test pass) |
| `implement-criterion-direct.prompt.md` | next-step's implementation phase for manual-verification frames (no target test) |
| `review-singlepass.prompt.md` | TICKET_VALIDATE's code review gate |
| `review-test-quality.prompt.md` | Gating test-quality review inside WRITE_TEST's retry loop (advisory fallback on budget exhaustion) |
| `review-ticket.prompt.md` | review-ticket command |
| `propose-ticket-edit.prompt.md` | propose-ticket-edit command |
| `split-ticket.prompt.md` | split-ticket complexity check |

## Architectural Principles

1. **Single-owner rule** — only `next-step` writes to `.criteria-stack.json`
   (and `push-ticket` at seed time). The implementation phase never touches the
   stack directly; it only makes the top frame's test pass. This makes failure
   safe: if implementation exhausts its attempts, the frame is still
   `test-written`, the test is still red, and `next-step` drops back into
   AWAIT_IMPL.

2. **Guard-first** — every precondition is re-checked from real state before
   any AI call spends money. `push-ticket` checks re-entrancy/clobber guards
   before touching any file. `next-step` checks stack state, frame status, and
   scoped-test redness before running the Implementor.

3. **Status is a hint, never a trust boundary** — `next-step` re-detects
   real state at the top of every step. A frame stored as `"test-written"`
   might have been fixed by a human; the phase check re-runs the tests and
   dispatches based on what's actually red/green, not what's stored.

4. **Test tamper guard** — the implementation phase snapshots each test function's
   source (brace-counting extraction) before the first attempt and verifies
   it byte-for-byte unchanged after every attempt. Modifying the test to
   make it pass is a hard, mechanical failure. Pipeline bookkeeping files
   (`.criteria-stack.json`, scratch files) are also write-protected.

5. **No shell for the model** — the pipeline's in-process tool layer
   (`tools.py`) provides `read_file`, `write_file`, `search_files`,
   `list_dir`, and `ask_user_prompt`. `run_command` is explicitly offered
   but always refused — there is no shell behind the tool layer, ever.
   Build/test verification is handled by the pipeline scripts between steps,
   not by the model.

6. **Grounding check** — before any criterion becomes a stack frame, a
   mechanical (no-AI) check verifies that symbols/tokens mentioned in the
   criterion actually exist in the codebase. Criteria that fail are recorded
   in `.declined-criteria.json` and never pushed, preventing the AI from
   working against phantom requirements.

7. **Sentinel-based crash recovery** — `TICKET_VALIDATE` pushes a
   `"validating"` sentinel frame before doing anything fallible (network
   fetch, AI calls, lint, test suite, smoke). If the process dies
   mid-validation, the sentinel survives on the stack and the next
   `next-step` call resumes validation from scratch.

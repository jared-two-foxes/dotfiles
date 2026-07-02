#!/usr/bin/env python3
"""
resolve-ticket - re-entrant pipeline: fetch a ticket, plan it, narrow the
plan down to whatever the codebase doesn't satisfy yet, and implement
that gap one acceptance criterion at a time.

Re-entrant by design: every step's real output (a file's content, a
compiler exit code, a scoped test's pass/fail) is its own proof of
completion - there's no separate progress manifest to get out of sync
with reality. Interrupt this at any point, fix whatever broke, and
re-invoke: it walks forward from whatever's already done (verified by
re-checking real state, not by trusting a record of what happened last
time) and resumes at the first thing that isn't. `--reset` clears only
this pipeline's own bookkeeping files (ticket/plan/gap-plan/log) - it
never touches test or implementation source files, since those are real
work product, not scaffolding; reverting code is your own job via git.

Planning pipeline (runs once per ticket, skipped on resume if already
done - see pipeline_lib.walk):
  1. Fetch ticket from Linear.
  2. Generate a TDD plan from the ticket.
  3. Narrow the plan to just the acceptance criteria the current
     codebase doesn't satisfy yet (read-only evidence-gathering) -
     written to .gap-plan.md in the same format as the plan itself.
     Zero remaining criteria means the ticket is already fully
     implemented. check-ticket.py runs this same narrow step and writes
     the same file, so if it reports a gap, resolve-ticket.py skips
     straight to the implementation pipeline below on the next run.

Implementation pipeline (iterates per acceptance criterion in the gap
plan; each criterion's own scoped test is both its witness of
completion and its resume point):
  for each criterion:
    - if its test already exists and passes, skip (already done).
    - write a failing test for just this criterion (test_writer),
      and record which test it wrote as a "Test:" annotation directly
      on .gap-plan.md - tests are organized by subject in this codebase,
      not by criterion, so this pointer can't be rediscovered later by
      naming convention; it has to be recorded once, by the step that
      knows it.
    - gate: the whole test suite must still compile.
    - gate: that one scoped test must fail (red) - if it's unexpectedly
      green, the gap didn't reproduce; skip straight to the next
      criterion, no implementation needed.
    - implement against just this criterion and its test (implementer;
      test file write-protected).
    - gate: the whole test suite must still compile.
    - gate: that one scoped test must now pass (green) - single-shot, no
      second implementation attempt if it doesn't.

Once every criterion is implemented and passing: a lint gate (fmt
--check, clippy), then a full test suite run (test_cmd), then code
review (read-only) over every file changed across every criterion,
against the *original* plan (full ticket scope, not just the narrowed
gap). All single-shot, no retry. Lint/style checks run only here, never
as acceptance-criteria evidence during narrowing - they're not evidence
of whether a feature is implemented, just of code health once it is.
The full-suite run exists because each criterion's own gate only proves
*its* scoped test passes at the moment it's implemented - a later
criterion's implementation can silently regress an earlier one's test,
and nothing else in this loop re-checks that.

Build/test commands come from a project-local TOML config (see
--config), same as tdd-pipeline.py, plus a templated test_filter_cmd
(default "cargo test {filter}") for running one criterion's scoped test -
compiling can't be scoped the same way (a test binary compiles
everything in it regardless of which test you'll filter at runtime), so
only the run is ever scoped, never the compile. fmt_check_cmd/clippy_cmd
(defaults: "cargo fmt -- --check" / "cargo clippy -- -D warnings") are
the lint gate's commands.

check-ticket.py and tdd-pipeline.py are unaffected by any of this - they
keep their existing single-shot behavior unchanged.

Usage:
    resolve-ticket <ticket-id> [--model <model-id>] [--config <path>] [--reset]
"""

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import ai_client  # noqa: E402
import pipeline_lib as lib  # noqa: E402
import render  # noqa: E402
import verbosity  # noqa: E402

log = verbosity.get_logger(__name__)

DEFAULT_MODEL = "opencode:gpt-5.4-mini"


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Re-entrant pipeline: fetch a ticket, narrow the plan "
                     "to the current gap, and implement it one criterion "
                     "at a time.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument("ticket_id", help="Linear ticket ID, e.g. NEB-42")
    parser.add_argument(
        "--model",
        default=DEFAULT_MODEL,
        help=f"opencode zen model ID to use (default: {DEFAULT_MODEL}).",
    )
    parser.add_argument(
        "--config",
        default=str(lib.PIPELINE_CONFIG_FILE),
        help=f"Path to the build/test command config (default: {lib.PIPELINE_CONFIG_FILE}).",
    )
    parser.add_argument(
        "--reset",
        action="store_true",
        help="Clear this pipeline's own state (ticket/plan/gap-plan/log) "
             "and start over. Never touches test or implementation source "
             "files already written.",
    )
    parser.add_argument(
        "--ticket-file-in",
        type=Path,
        default=None,
        help="Read the ticket from this local file instead of fetching from "
             "Linear - e.g. a not-yet-pushed revision from propose-ticket-edit.py. "
             "Only used the first time fetch_ticket runs (ignored on a re-entrant "
             "run where .ticket.md already exists).",
    )
    parser.add_argument(
        "--log-level",
        default="info",
        choices=list(verbosity.LEVELS),
        help="Console verbosity (default: info). 'debug' shows per-tool-call "
             "activity and command output even on success; 'trace' adds raw "
             "request/response payloads; 'warning'/'error'/'critical' show "
             "progressively less.",
    )
    args = parser.parse_args()
    verbosity.setup_logging(args.log_level)
    model = args.model

    if args.reset:
        lib.reset_pipeline_state()
    else:
        lib.show_last_failure()

    ticket_id = args.ticket_id

    # ── Planning pipeline (re-entrant: each block skipped if already done) ──
    lib.walk(lib.build_planning_blocks(ticket_id, model, ticket_file_in=args.ticket_file_in))

    plan_text = lib.PLAN_FILE.read_text(encoding="utf-8")
    gap_plan_text = lib.GAP_PLAN_FILE.read_text(encoding="utf-8")

    criteria = lib.extract_acceptance_criteria(gap_plan_text)
    if not criteria:
        render.print_line()
        render.print_line("-- No gap found. Success.")
        render.print_line(f"-- Token usage: {ai_client.usage}")
        return

    commands = lib.load_pipeline_config(Path(args.config))

    outcomes: list[str] = []

    def log_summary() -> None:
        render.print_line()
        render.print_line("-- Summary:")
        for line in outcomes:
            render.print_line(f"   {line}")

    # ── Implementation pipeline: one acceptance criterion at a time ───────
    changed_files: list[str] = []
    for criterion in criteria:
        log.info("\n-- Criterion: %s", criterion)
        existing = lib.find_criterion_test(gap_plan_text, criterion)

        if existing and lib.criterion_test_exists(*existing):
            file_path, test_name = existing
            result = lib.run_scoped_test(test_name, commands, "resume check")
            if result.returncode == 0:
                log.info("-- Already satisfied (resumed). Skipping.")
                outcomes.append(f"[already satisfied] {criterion}")
                continue
        else:
            file_path, test_name = lib.run_test_for_criterion(criterion, gap_plan_text, model)
            gap_plan_text = lib.annotate_criterion_test(lib.GAP_PLAN_FILE, criterion, file_path, test_name)

        result = lib.run_command(commands["test_compile_cmd"], "test compile gate")
        if result.returncode != 0:
            outcomes.append(f"[failed: tests do not compile] {criterion} -> {file_path} :: {test_name}")
            log_summary()
            lib.die_with_log(
                "compile", f"Tests do not compile (exit {result.returncode}). See output above.",
                criterion=criterion,
            )

        result = lib.run_scoped_test(test_name, commands, "red check")
        if result.returncode == 0:
            log.info(
                "-- Test passed without implementation - this criterion's "
                "gap didn't reproduce. Skipping implement."
            )
            outcomes.append(f"[gap did not reproduce, skipped] {criterion}")
            continue

        new_changed = lib.run_implement_for_criterion(
            criterion, gap_plan_text, model, file_path, test_name
        )
        changed_files.extend(new_changed)

        result = lib.run_command(commands["build_cmd"], "build gate")
        if result.returncode != 0:
            outcomes.append(
                f"[failed: code does not compile] {criterion} -> tried changing {', '.join(new_changed)}"
            )
            log_summary()
            lib.die_with_log(
                "build", f"Code does not compile (exit {result.returncode}). See output above.",
                criterion=criterion,
            )

        result = lib.run_scoped_test(test_name, commands, "green check")
        if result.returncode != 0:
            outcomes.append(
                f"[failed: test still red after implementation] {criterion} -> "
                f"tried changing {', '.join(new_changed)}"
            )
            log_summary()
            lib.die_with_log(
                "test-green",
                f"Test still fails after implementation (exit {result.returncode}). "
                f"This is a single-shot pipeline - no second attempt. See output above.",
                criterion=criterion,
            )

        outcomes.append(
            f"[implemented] {criterion} -> {file_path} :: {test_name} "
            f"(changed: {', '.join(new_changed)})"
        )

    # ── Lint gate + full-suite gate + final code review ────────────────────
    if changed_files:
        lib.run_lint_gate(commands)

        result = lib.run_command(commands["test_cmd"], "full test suite gate")
        if result.returncode != 0:
            log_summary()
            lib.die_with_log(
                "test-suite",
                f"Full test suite fails after all criteria implemented (exit "
                f"{result.returncode}). A criterion's scoped test passing "
                f"doesn't guarantee an earlier criterion's test still does - "
                f"see output above.",
            )

        lib.run_review_gate(changed_files, plan_text, model)

    log_summary()
    render.print_line()
    render.print_line("-- Gap implemented, tests pass, review approved. Success.")
    render.print_line(f"-- Token usage: {ai_client.usage}")


if __name__ == "__main__":
    main()

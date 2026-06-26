#!/usr/bin/env python3
"""
implement-tests - given a .gap-plan.md whose acceptance criteria already
have failing tests recorded against them (write-tests.py), implement
production code against each one, one criterion at a time. No test
writing here - that's an explicit precondition, not a fallback.

Closes the loop write-tests.py left open: check-ticket.py (confirm work
is needed, optional) -> write-tests.py (write failing tests, optional) ->
this script (implement against them) -> validate-and-review.py (gate the
result). resolve-ticket.py already does test-writing and implementation
together, interleaved per criterion - this script is for the case where
you deliberately want to inspect/adjust the written tests before any
implementation runs against them, so they're separate, re-entrant steps
instead of one combined loop.

Hard precondition, not a fallback: any remaining criterion with no test
recorded (or a recorded test file that no longer exists) fails this
script immediately rather than writing one itself - if you want that,
run write-tests.py (or resolve-ticket.py, which does both). Re-running
this script after fixing the gap plan/tests by hand picks up from there.

Per criterion (same gates as resolve-ticket.py's implementation loop):
  - if its recorded test already passes, skip (already done).
  - gate: the whole test suite must still compile.
  - gate: that one scoped test must fail (red) - if it's unexpectedly
    green, the gap didn't reproduce; skip straight to the next criterion.
  - implement against just this criterion and its test (test file
    write-protected).
  - gate: the whole test suite must still compile.
  - gate: that one scoped test must now pass (green) - single-shot, no
    second implementation attempt if it doesn't.

Once every criterion that needed work is implemented and passing: lint
gate, full test suite gate, then code review over every file changed,
against the full ticket scope in .tdd-plan.md (not just the narrowed
gap) - same tail as resolve-ticket.py.

Usage:
    implement-tests <ticket-id> [--model <model-id>] [--config <path>]
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
        description="Implement production code against already-written failing "
                     "tests, one acceptance criterion at a time. No test writing.",
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

    lib.show_last_failure()

    if not lib.PLAN_FILE.is_file():
        lib.die(f"{lib.PLAN_FILE} not found. Run check-ticket.py/write-tests.py first.")
    if not lib.GAP_PLAN_FILE.is_file():
        lib.die(f"{lib.GAP_PLAN_FILE} not found. Run check-ticket.py/write-tests.py first.")

    plan_text = lib.PLAN_FILE.read_text(encoding="utf-8")
    gap_plan_text = lib.GAP_PLAN_FILE.read_text(encoding="utf-8")

    criteria = lib.extract_acceptance_criteria(gap_plan_text)
    if not criteria:
        render.print_line()
        render.print_line("-- No gap found. Nothing to implement.")
        render.print_line(f"-- Token usage: {ai_client.usage}")
        return

    commands = lib.load_pipeline_config(Path(args.config))

    outcomes: list[str] = []

    def log_summary() -> None:
        render.print_line()
        render.print_line("-- Summary:")
        for line in outcomes:
            render.print_line(f"   {line}")

    changed_files: list[str] = []
    for criterion in criteria:
        log.info("\n-- Criterion: %s", criterion)
        existing = lib.find_criterion_test(gap_plan_text, criterion)
        if not existing or not lib.criterion_test_exists(*existing):
            outcomes.append(f"[no test recorded] {criterion}")
            log_summary()
            lib.die_with_log(
                "implement",
                f"No recorded, existing test for this criterion in {lib.GAP_PLAN_FILE}. "
                f"implement-tests.py never writes tests itself - run write-tests.py "
                f"(or resolve-ticket.py) first.",
                criterion=criterion,
            )

        file_path, test_name = existing
        result = lib.run_scoped_test(test_name, commands, "resume check")
        if result.returncode == 0:
            log.info("-- Already satisfied (resumed). Skipping.")
            outcomes.append(f"[already satisfied] {criterion}")
            continue

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

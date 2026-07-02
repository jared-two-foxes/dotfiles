#!/usr/bin/env python3
"""
write-tests - given a ticket (or an existing .gap-plan.md from a prior
check-ticket.py/resolve-ticket.py run), write failing tests for every
acceptance criterion the codebase doesn't satisfy yet. No
implementation - that's a manual step that follows this one.

Re-entrant: fetch/plan/narrow are skipped if .ticket.md/.tdd-plan.md/
.gap-plan.md already exist and pass their validity check (see
pipeline_lib.build_planning_blocks), and each criterion already
recorded in .gap-plan.md (a "Test: <file> :: <name>" line written by a
prior run) is never rewritten - it's re-verified (compile gate, then a
scoped run) and skipped either way, whether that scoped run passes
(already covered) or still fails red (implementation pending). This
also makes the test-compile gate failure below resumable: fix the
compile error by hand, then just rerun the same command - criteria
already written are re-checked, not redone, and the loop picks up at
the first criterion that still has no test.

--max-new turns this into a write-next-test loop: pass --max-new 1 and
the script stops right after writing its first genuinely new test for
this run, instead of continuing on through every remaining criterion.
Combined with the skip-if-already-covered logic above, this gives you a
manual RED-GREEN-RED cycle - write-tests --max-new 1, implement that one
criterion to green, write-tests --max-new 1 again (the just-greened
criterion is skipped as "already covered", and the next uncovered
criterion gets a new test), repeat - without ever writing two untested
criteria's tests ahead of where your implementation actually is.
Already-covered/already-written skips don't count against the limit,
since they're free re-checks, not new work.

Workflow this is part of: check-ticket.py (confirm work is needed) ->
write-tests.py (this script, optional) -> implement-tests.py (implement
against the tests this script wrote, optional) or manual implementation
-> validate-and-review.py (gate the result).

Usage:
    write-tests <ticket-id> [--model <model-id>] [--config <path>]
                [--max-new <n>]
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
        description="Write failing tests for every acceptance criterion the "
                     "codebase doesn't satisfy yet. No implementation.",
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
        "--max-new",
        type=int,
        default=None,
        help="Stop after writing this many genuinely new tests (criteria "
             "skipped as already-covered/already-written don't count). "
             "Omit to write tests for every remaining criterion in one run "
             "(default). Pass 1 to use this as a write-next-test loop: "
             "write one, implement it to green, call again for the next.",
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

    lib.show_last_failure()

    # ── Planning pipeline (re-entrant: shared with resolve-ticket.py) ──────
    lib.walk(lib.build_planning_blocks(args.ticket_id, model, ticket_file_in=args.ticket_file_in))

    gap_plan_text = lib.GAP_PLAN_FILE.read_text(encoding="utf-8")
    criteria = lib.extract_acceptance_criteria(gap_plan_text)
    if not criteria:
        render.print_line()
        render.print_line("-- No gap found. Nothing to test.")
        render.print_line(f"-- Token usage: {ai_client.usage}")
        return

    commands = lib.load_pipeline_config(Path(args.config))

    outcomes: list[str] = []

    def log_summary() -> None:
        render.print_line()
        render.print_line("-- Summary:")
        for line in outcomes:
            render.print_line(f"   {line}")

    written = 0
    skipped = 0
    for criterion in criteria:
        log.info("\n-- Criterion: %s", criterion)
        existing = lib.find_criterion_test(gap_plan_text, criterion)

        if existing and lib.criterion_test_exists(*existing):
            file_path, test_name = existing
            # A prior run may have died at the compile gate (see below) after
            # annotating this criterion's test but before the suite compiled
            # cleanly. Re-check compilation here so resuming after a manual
            # fix doesn't silently skip a criterion whose test still doesn't
            # build - we'd otherwise treat "exists" as "fine" and move on.
            compile_result = lib.run_command(commands["test_compile_cmd"], "test compile gate (resume check)")
            if compile_result.returncode != 0:
                log_summary()
                lib.die_with_log(
                    "compile", f"Tests still do not compile (exit {compile_result.returncode}). See output above.",
                    criterion=criterion,
                )
            result = lib.run_scoped_test(test_name, commands, "resume check")
            if result.returncode == 0:
                log.info("-- Already covered by a passing test. Skipping.")
                skipped += 1
                outcomes.append(f"[already covered] {criterion} -> {file_path} :: {test_name}")
            else:
                log.info("-- Test already written and compiles (not yet passing - implementation pending). Skipping rewrite.")
                skipped += 1
                outcomes.append(f"[already written] {criterion} -> {file_path} :: {test_name}")
            continue

        file_path, test_name = lib.run_test_for_criterion(criterion, gap_plan_text, model)
        gap_plan_text = lib.annotate_criterion_test(lib.GAP_PLAN_FILE, criterion, file_path, test_name)
        written += 1
        outcomes.append(f"[written] {criterion} -> {file_path} :: {test_name}")

        result = lib.run_command(commands["test_compile_cmd"], "test compile gate")
        if result.returncode != 0:
            log_summary()
            lib.die_with_log(
                "compile", f"Tests do not compile (exit {result.returncode}). See output above.",
                criterion=criterion,
            )

        if args.max_new is not None and written >= args.max_new:
            log.info("-- Hit --max-new (%d). Stopping before the next criterion.", args.max_new)
            break

    log_summary()
    render.print_line(
        f"-- {written} test(s) written, {skipped} criterion(criteria) already "
        f"covered. Run 'implement-tests {args.ticket_id}' (or implement against "
        f"{lib.GAP_PLAN_FILE} by hand), then 'validate-and-review {args.ticket_id}'."
    )
    render.print_line(f"-- Token usage: {ai_client.usage}")


if __name__ == "__main__":
    main()

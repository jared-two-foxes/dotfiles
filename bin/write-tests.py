#!/usr/bin/env python3
"""
write-tests - given a ticket (or an existing .gap-plan.md from a prior
check-ticket.py/resolve-ticket.py run), write failing tests for every
acceptance criterion the codebase doesn't satisfy yet. No
implementation - that's a manual step that follows this one.

Re-entrant: fetch/plan/narrow are skipped if .ticket.md/.tdd-plan.md/
.gap-plan.md already exist and pass their validity check (see
pipeline_lib.build_planning_blocks), and each criterion is skipped if it
already has a recorded test that passes when run scoped - so running
this again after some criteria already have tests (e.g. from manual
work since the last run) only writes tests for what's still missing.

Workflow this is part of: check-ticket.py (confirm work is needed) ->
write-tests.py (this script, optional) -> manual implementation ->
validate-and-review.py (gate the result).

Usage:
    write-tests <ticket-id> [--model <model-id>] [--config <path>]
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
            result = lib.run_scoped_test(test_name, commands, "resume check")
            if result.returncode == 0:
                log.info("-- Already covered by a passing test. Skipping.")
                skipped += 1
                outcomes.append(f"[already covered] {criterion} -> {file_path} :: {test_name}")
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

    log_summary()
    render.print_line(
        f"-- {written} test(s) written, {skipped} criterion(criteria) already "
        f"covered. Implement against {lib.GAP_PLAN_FILE}, then run "
        f"'validate-and-review {args.ticket_id}'."
    )
    render.print_line(f"-- Token usage: {ai_client.usage}")


if __name__ == "__main__":
    main()

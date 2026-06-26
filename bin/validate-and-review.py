#!/usr/bin/env python3
"""
validate-and-review - gate manually-implemented work against a ticket:
re-check every acceptance criterion against the codebase as it stands
right now, then lint, full test suite, an optional smoke test, and a
final code review against the original plan's full ticket scope.

Hard gate, not a report: any acceptance criterion still unsatisfied
fails this script immediately and lists what's left - this is meant to
block a merge the same way a failing test would, not just print a note
(contrast check-ticket.py, which always reports and exits 0 regardless
of outcome).

Always re-narrows fresh against the current codebase - never trusts a
.gap-plan.md left over from before the manual work, since that's
exactly the state this script needs to re-check.

Re-entrant like the rest of this workflow: if .tdd-plan.md already
exists (from an earlier check-ticket.py/write-tests.py run), it's reused
as-is, never regenerated - it defines the scope the work was actually
done against, and re-planning here could silently drift from that. If
it doesn't exist yet, this script generates one itself, so it can also
be the *first* thing you run for a ticket - e.g. when you already know
work is needed and just want the end-state gate, with no prior
check-ticket.py/write-tests.py call.

Workflow this is part of: check-ticket.py (confirm work is needed,
optional) -> write-tests.py (optional) -> implement-tests.py or manual
implementation -> this script.

Usage:
    validate-and-review <ticket-id> [--model <model-id>] [--config <path>]
                         [--ticket-file-in <path>]
"""

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import ai_client  # noqa: E402
import pipeline_lib as lib  # noqa: E402
import render  # noqa: E402
import tools  # noqa: E402
import verbosity  # noqa: E402

log = verbosity.get_logger(__name__)

DEFAULT_MODEL = "opencode:gpt-5.4-mini"


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Gate manually-implemented work: acceptance criteria, "
                     "lint, full test suite, optional smoke test, code review.",
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
             "Re-read every run, same as the Linear fetch it replaces (this "
             "script always re-fetches fresh, never reuses a stale .ticket.md).",
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

    # ── Step 1: Re-fetch ticket fresh ───────────────────────────────────────
    if args.ticket_file_in is not None:
        if not args.ticket_file_in.is_file():
            lib.die(f"--ticket-file-in {args.ticket_file_in} not found.")
        render.print_line(f"-- Using local ticket file {args.ticket_file_in} instead of fetching {args.ticket_id} from Linear.")
        ticket_content = args.ticket_file_in.read_text(encoding="utf-8")
    else:
        ticket_content = lib.fetch_ticket_text(args.ticket_id)
    tools.write_file_block(str(lib.TICKET_FILE))(ticket_content)

    # ── Step 2: Plan - reused if it already exists, generated if not ──────
    # Re-entrant: this script can be the first thing run for a ticket (no
    # prior check-ticket.py/write-tests.py call), e.g. when you already
    # know work is needed and just want the end-state gate. Unlike the
    # ticket fetch above, an existing plan is trusted as-is, not
    # regenerated - it defines the scope manual work was actually done
    # against, and re-planning here could silently drift from that.
    if lib.PLAN_FILE.is_file():
        plan_text = lib.PLAN_FILE.read_text(encoding="utf-8")
    else:
        plan_text = lib.run_plan_step(ticket_content, model)

    # ── Step 3: AC check - always a fresh re-narrow, hard gate ─────────────
    gap_plan_content = lib.run_narrow_step(ticket_content, plan_text, model)
    remaining = lib.extract_acceptance_criteria(gap_plan_content)
    if remaining:
        criteria_list = "\n".join(f"  {c}" for c in remaining)
        lib.die_with_log(
            "validate",
            f"{len(remaining)} acceptance criterion(criteria) still unsatisfied:\n{criteria_list}",
        )

    commands = lib.load_pipeline_config(Path(args.config))

    # ── Step 4: Lint gate ────────────────────────────────────────────────────
    lib.run_lint_gate(commands)

    # ── Step 5: Full test suite gate ────────────────────────────────────────
    result = lib.run_command(commands["test_cmd"], "full test suite gate")
    if result.returncode != 0:
        lib.die_with_log(
            "test-suite",
            f"Full test suite fails (exit {result.returncode}). See output above.",
        )

    # ── Step 6: Smoke test (stub - skips unless smoke_cmd is configured) ──
    smoke_cmd = lib.load_smoke_cmd(Path(args.config))
    lib.run_smoke_gate(smoke_cmd)

    # ── Step 7: Discover what was actually changed ──────────────────────────
    changed_files = lib.git_changed_files()
    if not changed_files:
        lib.die("No changed files found (git diff/untracked are both empty). Nothing to review.")

    # ── Step 8: Code review against the original plan's full scope ────────
    lib.run_review_gate(changed_files, plan_text, model)

    render.print_line()
    render.print_line("-- Summary:")
    render.print_line("   Acceptance criteria: all satisfied")
    render.print_line("   Lint: clean")
    render.print_line("   Test suite: passed")
    render.print_line(f"   Smoke test: {'passed' if smoke_cmd else 'skipped (not configured)'}")
    render.print_line(f"   Files reviewed ({len(changed_files)}): {', '.join(changed_files)}")
    render.print_line("   Code review: APPROVED")
    render.print_line()
    render.print_line("-- All acceptance criteria satisfied, lint clean, tests pass, review approved. Success.")
    render.print_line(f"-- Token usage: {ai_client.usage}")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""
push_ticket - fetch a Linear ticket, run plan+narrow, and seed
.criteria-stack.json with one frame per remaining acceptance criterion.
The starting gesture of the criteria-stack pipeline: run this once per
ticket, then run `next_step` repeatedly to advance it.

Guard-first, not cleanup-first: the re-entrancy check (stack already has
this ticket) and the clobber check (stack has a *different* ticket, and
neither --force nor --prepend was passed) both run before any file on
disk is touched. Only once the guard has passed does this script clear
its own scratch state (.ticket.md/.tdd-plan.md/.gap-plan.md) and write
the new stack. This ordering matters: an earlier design cleared scratch
state first and checked the guard after, which meant the file the guard
was checking had already been deleted by the time it looked - the guard
could never fire. See criteria-stack-plan.md's Retirement section for
the full story.

Pushing a *different* ticket while one is already in progress has two
distinct resolutions, not one - --force and --prepend are mutually
exclusive and mean very different things:

  --force    Abandon the in-progress stack. Replaces it entirely with
             the new ticket's frames. Use this when the in-progress
             ticket was pushed by mistake, or you're deliberately
             dropping it.

  --prepend  Insert the new ticket's frames *ahead* of the in-progress
             stack, as a prerequisite. The in-progress stack is kept
             intact underneath, not discarded. Once the new ticket's
             own frames are all popped, TICKET_VALIDATE runs for it
             (same tag-change-at-pop-time trigger as any other ticket
             boundary) and, once approved, the original ticket's
             criteria resume automatically on the next `next_step`
             call - no special-casing needed, since the stack's own
             pop/validate logic already treats "the next frame belongs
             to a different ticket" as a ticket boundary regardless of
             how it got there. Use this when working the current
             ticket's top criterion reveals that some other, not-yet-
             built piece needs to exist first.

.criteria-stack.json is the only file this pipeline trusts across
invocations. .ticket.md/.tdd-plan.md/.gap-plan.md are transient scratch,
regenerated here and again by next_step's TICKET_VALIDATE phase - not
read back by any later, separate run the way they used to be. Safe to
clear on every push (including --prepend) because each frame carries
its own plan_context already extracted at push time - a frame never
depends on these scratch files still existing later.

--validate-only skips fetch/plan/narrow and criteria-building entirely -
it just pushes the same "validating" sentinel frame next_step's
TICKET_VALIDATE phase itself pushes before doing anything fallible (see
lib.ensure_validating_sentinel), so the very next `next_step` call runs
the full validation gate (fresh re-narrow safety net, lint, full test
suite, smoke, code review) directly, with no criteria in between. Use
this to trigger a validation pass on demand - e.g. you believe a ticket
is already fully implemented and just want the gate to run, without
waiting for a criterion to naturally pop through the stack first. Goes
through the same guard as every other push (a --force/--prepend choice
if a different ticket is already in progress), and still clears scratch
state first, so TICKET_VALIDATE's own fetch/plan/narrow starts from a
clean slate rather than risking reuse of some unrelated ticket's stale
.tdd-plan.md.

Usage:
    push_ticket <ticket-id> [--model <model-id>] [--ticket-file-in <path>]
                [--from-gap-plan | --validate-only] [--force | --prepend]
                [--log-level <level>]
"""

import argparse
import sys
from pathlib import Path

from .lib import ai_client, pipeline_lib as lib, render, verbosity

log = verbosity.get_logger(__name__)

DEFAULT_MODEL = "opencode:gpt-5.4-mini"


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Fetch a ticket, plan+narrow it, and seed the criteria "
                     "stack with one frame per remaining acceptance criterion.",
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
        "--ticket-file-in",
        type=Path,
        default=None,
        help="Read the ticket from this local file instead of fetching from "
             "Linear - e.g. a not-yet-pushed revision from propose-ticket-edit.py. "
             "Ignored with --from-gap-plan (no fetch happens either way).",
    )
    seed_group = parser.add_mutually_exclusive_group()
    seed_group.add_argument(
        "--from-gap-plan",
        action="store_true",
        help="Read criteria from the existing .gap-plan.md instead of "
             "fetching the ticket and re-running plan+narrow. The ticket ID "
             "is still required (for the frame tag). Errors if .gap-plan.md "
             "does not exist or isn't a valid gap plan. Use this after an "
             "earlier plan+narrow run already produced .gap-plan.md and you "
             "just want to seed the stack from it without paying for "
             "another plan+narrow.",
    )
    seed_group.add_argument(
        "--validate-only",
        action="store_true",
        help="Skip fetch/plan/narrow and criteria-building entirely - just "
             "push a 'validating' sentinel for this ticket, so the next "
             "'next_step' call runs the full ticket-validation gate (fresh "
             "re-narrow safety net, lint, full test suite, smoke, code "
             "review) directly. Use this to trigger a validation pass on "
             "demand, e.g. when you believe the ticket is already fully "
             "implemented and just want the gate to run.",
    )
    guard_group = parser.add_mutually_exclusive_group()
    guard_group.add_argument(
        "--force",
        action="store_true",
        help="Abandon and replace an in-progress stack for a different "
             "ticket. Without --force or --prepend, pushing a different "
             "ticket while one is already in progress prints a warning "
             "and exits non-zero.",
    )
    guard_group.add_argument(
        "--prepend",
        action="store_true",
        help="Insert this ticket's frames ahead of an in-progress stack "
             "for a different ticket, as a prerequisite - the in-progress "
             "stack is kept, not discarded, and resumes automatically once "
             "this ticket's own frames are popped and validated. Use this "
             "when the current top criterion turns out to depend on some "
             "other system that doesn't exist yet.",
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
    ticket_id = args.ticket_id

    # ── Guard: runs before any file is touched ─────────────────────────────
    existing = lib.load_stack()
    if existing:
        if existing[0].ticket == ticket_id:
            render.print_line(
                f"-- Stack already has {len(existing)} frame(s) for {ticket_id}. "
                f"Run 'next_step' to continue."
            )
            return
        if args.prepend:
            # Same ticket appearing twice, non-contiguously, would break
            # the tag-change-at-pop-time trigger TICKET_VALIDATE relies on
            # (it would fire when leaving the *first* occurrence, even
            # though more frames for that ticket sit further down) - refuse
            # rather than silently corrupt that invariant.
            if any(f.ticket == ticket_id for f in existing):
                lib.die(
                    f"{ticket_id} already has frame(s) elsewhere in the stack "
                    f"(not at the top) - --prepend would split them apart and "
                    f"break ticket-boundary detection. Run 'next_step' until "
                    f"they're worked through, or use --force to discard the "
                    f"whole stack and start over."
                )
            log.info(
                "-- --prepend: inserting %s ahead of %d frame(s) in progress for %s.",
                ticket_id, len(existing), existing[0].ticket,
            )
        elif not args.force:
            render.print_line(
                f"-- Stack has {len(existing)} frame(s) in progress for "
                f"{existing[0].ticket}, not {ticket_id}. Pass --force to "
                f"overwrite it (discards the in-progress stack; already-"
                f"written test/implementation files are untouched) or "
                f"--prepend to insert {ticket_id} ahead of it as a "
                f"prerequisite (keeps the in-progress stack intact)."
            )
            sys.exit(1)
        else:
            log.info(
                "-- --force: overwriting in-progress stack for %s with %s.",
                existing[0].ticket, ticket_id,
            )

    # ── Cleanup: only once the guard above has passed ──────────────────────
    # GAP_PLAN_FILE is deliberately spared under --from-gap-plan - that
    # flag's whole point is to reuse the existing one instead of paying
    # for another plan+narrow, so clearing it here would immediately
    # contradict the flag that was just passed. --validate-only clears
    # everything (it never reuses a gap plan) so TICKET_VALIDATE's own
    # fetch/plan/narrow starts clean rather than risking reuse of some
    # unrelated ticket's stale .tdd-plan.md.
    scratch_files = (lib.TICKET_FILE, lib.PLAN_FILE) if args.from_gap_plan else (
        lib.TICKET_FILE, lib.PLAN_FILE, lib.GAP_PLAN_FILE
    )
    lib.remove_scratch_files(scratch_files)

    if args.validate_only:
        lib.ensure_validating_sentinel(ticket_id)
        render.print_line()
        render.print_line(f"-- Pushed a validation-pending marker for {ticket_id}.")
        render.print_line("-- Run 'next_step' to run the full ticket validation gate now.")
        return

    # ── Seed the gap plan: fetch+plan+narrow, or reuse an existing one ─────
    if args.from_gap_plan:
        if not lib.GAP_PLAN_FILE.is_file():
            lib.die(f"--from-gap-plan given but {lib.GAP_PLAN_FILE} does not exist.")
        gap_plan_content = lib.GAP_PLAN_FILE.read_text(encoding="utf-8")
        if "## Acceptance Criteria" not in gap_plan_content:
            lib.die(f"--from-gap-plan given but {lib.GAP_PLAN_FILE} is not a valid gap plan (see output above).")
        render.print_line(f"-- Using existing {lib.GAP_PLAN_FILE} (--from-gap-plan). No fetch, no plan+narrow.")
    else:
        lib.walk(lib.build_planning_blocks(ticket_id, model, ticket_file_in=args.ticket_file_in))
        gap_plan_content = lib.GAP_PLAN_FILE.read_text(encoding="utf-8")

    # ── Build frames: one per remaining acceptance criterion ───────────────
    criteria = lib.extract_acceptance_criteria(gap_plan_content)
    if not criteria:
        render.print_line()
        render.print_line("-- No gap found. All acceptance criteria already satisfied. Nothing pushed.")
        render.print_line(f"-- Token usage: {ai_client.usage}")
        return

    frames = [
        lib.CriterionFrame(
            ticket=ticket_id,
            criterion=criterion,
            plan_context=lib.extract_plan_context_for_criterion(criterion, gap_plan_content),
            test_file=None,
            test_name=None,
            status="pending",
            origin="ticket",
        )
        for criterion in criteria
    ]

    if args.prepend and existing:
        lib.push_frames(frames)
        render.print_line()
        render.print_line(
            f"-- Prepended {len(frames)} criteria for {ticket_id} ahead of "
            f"{len(existing)} frame(s) still in progress for {existing[0].ticket}."
        )
        for frame in frames:
            render.print_line(f"   {frame.criterion}")
        render.print_line(
            f"-- Run 'next_step' to work through {ticket_id} first; "
            f"{existing[0].ticket} resumes automatically once it's validated."
        )
    else:
        lib.save_stack(frames)
        render.print_line()
        render.print_line(f"-- Pushed {len(frames)} criteria for {ticket_id} onto the stack.")
        for frame in frames:
            render.print_line(f"   {frame.criterion}")
        render.print_line("-- Run 'next_step' to begin.")
    render.print_line(f"-- Token usage: {ai_client.usage}")


if __name__ == "__main__":
    main()

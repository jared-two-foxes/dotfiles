#!/usr/bin/env python3
"""
push_ticket - fetch a Linear ticket, run plan+narrow, and seed
.criteria-stack.json with one frame per remaining acceptance criterion.
The starting gesture of the criteria-stack pipeline: run this once per
ticket, then run `next_step` repeatedly to advance it.

Bundles split-ticket.py's complexity check as its own first step for the
normal (non---validate-only, non---from-gap-plan) path: "how do I seed
the stack for this ticket" already has to account for "does this ticket
even map to one stack entry, or several" - that's not a separate concern
worth a separate command to invoke every time. split-ticket.py itself
stays a fully standalone command too, for previewing/triaging a ticket's
complexity without committing to pushing anything - this only changes
what push_ticket does *in addition*, not split-ticket.py's own reason to
exist.

On a "no-split" verdict (the common case), everything below behaves
exactly as it always has - fetch, plan+narrow, seed one frame per
acceptance criterion. On anything else, this creates the proposed
children as real Linear sub-issues (via create_child_tickets.py's
create_children(), --dry-run skips this and only previews), pushes a
"validating" sentinel frame for the parent (nothing left for it to
implement directly - the children between them cover every one of its
criteria, by split-ticket.py's own design), and recurses: each child
gets the exact same fetch -> split-check -> plan+narrow treatment,
in case a child itself still needs splitting further (rare, given
split-ticket.py is supposed to produce right-sized children, but
handled the same way regardless of depth rather than special-cased).
All frames from that recursion - real per-criterion frames and/or
further sentinels - are computed first and pushed once, together, in
the same combined write this script already made for the simple case
(the --prepend/--force guard and combine-with-existing-stack logic runs
once, at the very end, over the whole resolved list - not once per
ticket, which would have needed the same front-of-stack ordering
gymnastics --prepend already avoids for the single-ticket case).

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
regenerated here (once per ticket touched, including each child) and
again by next_step's TICKET_VALIDATE phase - not read back by any later,
separate run the way they used to be. Safe to clear on every push
(including --prepend, and every recursive child) because each frame
carries its own plan_context already extracted at push time - a frame
never depends on these scratch files still existing later.

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
.tdd-plan.md. Bypasses the split-check entirely - it never runs
fetch/plan/narrow for anything, so there's no ticket text to check.

--from-gap-plan similarly bypasses the split-check - its whole point is
reusing an already-planned gap plan instead of re-deriving anything, and
a gap plan's Acceptance Criteria section has already been through
whatever planning happened when it was created.

Usage:
    push_ticket <ticket-id> [--model <model-id>] [--ticket-file-in <path>]
                [--from-gap-plan | --validate-only] [--force | --prepend]
                [--split-threshold <n>] [--force-split-ai] [--dry-run]
                [--log-level <level>]
"""

import argparse
import json
import re
import sys
from pathlib import Path

from .lib import ai_client, pipeline_lib as lib, render, verbosity
from . import create_child_tickets, split_ticket

log = verbosity.get_logger(__name__)

DEFAULT_MODEL = "opencode:gpt-5.4-mini"

VERDICT_RE = re.compile(r"^###\s*Verdict\s*\n+(\S+)", re.MULTILINE)


def resolve_ticket_frames(
    ticket_id: str,
    model: str,
    ticket_file_in: Path | None,
    threshold: int | None,
    force_split_ai: bool,
    dry_run: bool,
) -> list[lib.CriterionFrame] | None:
    """
    Computes the ordered frames this ticket contributes to the stack -
    recursively, since a split's children go through this same function
    again. Returns None if there's nothing to push at all: either a
    --dry-run stopped at a split recommendation (only a preview shown -
    for this ticket or any of its children, aborting the whole call, not
    just the branch that hit it, since a partial push across a split
    would leave the stack half-seeded with no way to tell from outside),
    or (no-split case) the gap plan turned up no remaining criteria.
    """
    if ticket_file_in is not None:
        if not ticket_file_in.is_file():
            lib.die(f"--ticket-file-in {ticket_file_in} not found.")
        ticket_content = ticket_file_in.read_text(encoding="utf-8")
    else:
        ticket_content = lib.fetch_ticket_text(ticket_id)

    # A prior review-ticket.py report, if one exists for this exact
    # ticket, grounds the complexity check in what's already confirmed to
    # exist in the codebase - see split_ticket.py's own docstring for
    # what this does and doesn't change. Optional: most children won't
    # have one of their own (they're brand new Linear issues), and that's
    # fine, this is pure best-effort context.
    review_context = ""
    review_file = Path(f".ticket-review-{ticket_id}.md")
    if review_file.is_file():
        review_context = review_file.read_text(encoding="utf-8")

    if force_split_ai:
        mechanical_verdict = split_ticket.MechanicalVerdict.AMBIGUOUS
        mechanical_explanation = "Mechanical pre-check skipped (--force-split-ai)."
    else:
        mechanical_verdict, mechanical_explanation = split_ticket.mechanical_complexity_check(
            ticket_content, threshold if threshold is not None else split_ticket.COMPLEX_THRESHOLD
        )
    render.print_line(f"-- {ticket_id}: {mechanical_explanation}")

    if mechanical_verdict == split_ticket.MechanicalVerdict.SIMPLE:
        split_verdict = "no-split"
        report = None
    else:
        render.print_line(f"-- Running complexity check for {ticket_id} ...")
        report = split_ticket.run_split_step(ticket_content, mechanical_explanation, model, review_context)
        split_ticket.save_split(ticket_id, ticket_content, report)
        verdict_match = VERDICT_RE.search(report)
        if not verdict_match:
            lib.die(f"split-ticket step for {ticket_id} did not produce a '### Verdict' line (see output above).")
        split_verdict = verdict_match.group(1).strip().lower()

    if split_verdict != "no-split":
        render.print_line(f"-- {ticket_id}: split {split_verdict} - see {split_ticket.split_file_path(ticket_id)}.")
        children = create_child_tickets.parse_child_tickets(report)
        if not children:
            lib.die(f"{ticket_id}: verdict is '{split_verdict}' but no '#### Child N:' blocks were parsed.")
        render.print_line(f"-- {len(children)} proposed child ticket(s) for {ticket_id}:")
        for i, child in enumerate(children, 1):
            depends_note = f" - depends on: {child.depends_on}" if child.depends_on else ""
            render.print_line(f"   {i}. {child.title} ({len(child.criteria)} criteria){depends_note}")

        if dry_run:
            render.print_line(f"-- Dry run - nothing created or pushed for {ticket_id} or its proposed children.")
            return None

        result = create_child_tickets.create_children(ticket_id, children)
        manifest_path = create_child_tickets.children_file_path(ticket_id)
        manifest_path.write_text(json.dumps(result.created, indent=2) + "\n", encoding="utf-8")
        if result.failure is not None:
            lib.die(
                f"{ticket_id}: creating '{children[len(result.created)].title}' failed: {result.failure}. "
                f"{len(result.created)} child(ren) already created above were not rolled back - see "
                f"{manifest_path}."
            )

        child_frames: list[lib.CriterionFrame] = []
        for child in result.created:
            resolved = resolve_ticket_frames(child["id"], model, None, threshold, force_split_ai, dry_run)
            if resolved is None:
                return None
            child_frames += resolved

        sentinel = lib.CriterionFrame(
            ticket=ticket_id,
            criterion="(ticket validation pending)",
            plan_context="",
            test_file=None,
            test_name=None,
            status="validating",
            origin="ticket-validate",
        )
        return child_frames + [sentinel]

    # no-split: normal fetch+plan+narrow. Reuses the ticket_content
    # already in hand (fetched above for the split check) rather than
    # fetching a second time - written to TICKET_FILE so
    # build_planning_blocks' own re-entrant fetch block sees valid
    # content already there and doesn't re-fetch.
    lib.remove_scratch_files((lib.TICKET_FILE, lib.PLAN_FILE, lib.GAP_PLAN_FILE))
    lib.TICKET_FILE.write_text(ticket_content, encoding="utf-8")
    lib.walk(lib.build_planning_blocks(ticket_id, model, ticket_file_in=lib.TICKET_FILE))
    gap_plan_content = lib.GAP_PLAN_FILE.read_text(encoding="utf-8")

    criteria = lib.extract_acceptance_criteria(gap_plan_content)
    if not criteria:
        render.print_line(f"-- {ticket_id}: no gap found. All acceptance criteria already satisfied.")
        return []

    return [
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
             "another plan+narrow. Bypasses the split-check (see module "
             "docstring).",
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
             "implemented and just want the gate to run. Bypasses the "
             "split-check (see module docstring).",
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
        "--split-threshold", type=int, default=None,
        help="Passed through to the complexity check's acceptance-criteria "
             "threshold (default: split_ticket.py's own default). Ignored "
             "with --from-gap-plan/--validate-only.",
    )
    parser.add_argument(
        "--force-split-ai", action="store_true",
        help="Skip the complexity check's mechanical pre-check and always run "
             "its AI step. Ignored with --from-gap-plan/--validate-only.",
    )
    parser.add_argument(
        "--dry-run", action="store_true",
        help="If the complexity check recommends splitting (for this ticket or "
             "any child, at any depth): only preview the proposed children - "
             "don't create anything in Linear or push anything onto the stack. "
             "Ignored with --from-gap-plan/--validate-only.",
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

    if args.validate_only:
        # Full cleanup (unlike --from-gap-plan below): this never reuses
        # a gap plan, so TICKET_VALIDATE's own fetch/plan/narrow should
        # start from a clean slate rather than risking reuse of some
        # unrelated ticket's stale .tdd-plan.md.
        lib.remove_scratch_files((lib.TICKET_FILE, lib.PLAN_FILE, lib.GAP_PLAN_FILE))
        lib.ensure_validating_sentinel(ticket_id)
        render.print_line()
        render.print_line(f"-- Pushed a validation-pending marker for {ticket_id}.")
        render.print_line("-- Run 'next_step' to run the full ticket validation gate now.")
        return

    if args.from_gap_plan:
        # GAP_PLAN_FILE is deliberately spared - this flag's whole point
        # is reusing the existing one instead of paying for another
        # plan+narrow, so clearing it here would immediately contradict
        # the flag that was just passed.
        lib.remove_scratch_files((lib.TICKET_FILE, lib.PLAN_FILE))
        if not lib.GAP_PLAN_FILE.is_file():
            lib.die(f"--from-gap-plan given but {lib.GAP_PLAN_FILE} does not exist.")
        gap_plan_content = lib.GAP_PLAN_FILE.read_text(encoding="utf-8")
        if "## Acceptance Criteria" not in gap_plan_content:
            lib.die(f"--from-gap-plan given but {lib.GAP_PLAN_FILE} is not a valid gap plan (see output above).")
        render.print_line(f"-- Using existing {lib.GAP_PLAN_FILE} (--from-gap-plan). No fetch, no plan+narrow.")

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
    else:
        frames = resolve_ticket_frames(
            ticket_id, model, args.ticket_file_in, args.split_threshold, args.force_split_ai, args.dry_run,
        )
        if frames is None:
            render.print_line(f"-- Token usage: {ai_client.usage}")
            return
        if not frames:
            render.print_line("-- Nothing pushed.")
            render.print_line(f"-- Token usage: {ai_client.usage}")
            return

    # ── Combined write: once, over every frame resolved above ──────────────
    if args.prepend and existing:
        lib.push_frames(frames)
        render.print_line()
        render.print_line(
            f"-- Prepended {len(frames)} frame(s) for {ticket_id} ahead of "
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
        render.print_line(f"-- Pushed {len(frames)} frame(s) for {ticket_id} onto the stack.")
        for frame in frames:
            render.print_line(f"   {frame.criterion}")
        render.print_line("-- Run 'next_step' to begin.")
    render.print_line(f"-- Token usage: {ai_client.usage}")


if __name__ == "__main__":
    main()

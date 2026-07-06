#!/usr/bin/env python3
"""
next_step - advance the criteria stack by exactly one step, pausing
whenever human input (implementation) is genuinely required. The main
orchestrator of the criteria-stack pipeline; run `push_ticket <id>`
once to seed the stack, then run this repeatedly until it reports no
work remaining.

No ticket_id argument - the ticket is read from the stack itself.

Phase detection (re-run fresh from real state at the top of every
step - the frame's `status` field is a hint, never a trust boundary):

  stack empty                              -> done, nothing to do
  top frame status == "validating"         -> TICKET_VALIDATE (a prior
                                               attempt for this ticket
                                               died partway through;
                                               resume it directly)
  top frame status == "green-unconfirmed"  -> re-run its scoped test:
    now red                                -> becomes a normal
                                               test-written/AWAIT_IMPL case
                                               (someone fixed the test)
    still green, --accept-green passed     -> mark done, re-detect (POP)
    still green, no --accept-green         -> pause again (always exits)
  top frame status == "pending"            -> WRITE_TEST
  top frame status == "test-written",
    missing test_file/test_name            -> WRITE_TEST (retry)
  top frame status == "test-written"       -> re-run its scoped test:
    green                                  -> mark done, re-detect (POP)
    red                                    -> AWAIT_IMPL (always pauses)
  top frame status == "done"               -> POP

A freshly-written test that comes back green immediately is trusted
(marked done without pausing) only when the criterion is origin="ticket"
(the ticket's own initial criteria - one criterion's implementation can
legitimately satisfy a sibling as a side effect). For any other origin
(validate-missed/review - pushed *because* an independent check already
judged the criterion unsatisfied), an immediate green is untrusted by
default and becomes "green-unconfirmed" instead: much more likely a weak
test than the gap having genuinely disappeared, and auto-trusting it
here is what turns into a boundless validate -> false-green -> pop ->
re-validate loop, silently burning AI calls under --continuous with no
human ever seeing it. --accept-green explicitly confirms one is
legitimate and moves on.

POP removes the top frame. If the new top frame belongs to a different
ticket (or the stack is now empty), that ticket's frames are all done:
run TICKET_VALIDATE (fresh re-narrow safety net, lint, full test suite,
smoke, code review). Before doing anything fallible, TICKET_VALIDATE
pushes a durable "validating" sentinel frame for that ticket (popped
again only on an APPROVED verdict) - so if lint/the full test suite/
smoke/an unparseable review kills the process partway through, the
sentinel survives on the stack and the next `next_step` call resumes
validation instead of reporting "no work remaining" or moving on to a
different ticket with no way back to this one. A CHANGES REQUESTED
review, or a safety-net re-narrow that still finds criteria, pushes new
frames onto the stack ahead of the sentinel (tagged with the same
ticket) instead of failing outright, so the next `next_step` call picks
the pipeline back up automatically.

Exit codes: 0 at every human pause point (red test awaiting
implementation, review findings pushed, validate-missed criteria
pushed, stack empty) - the user must be able to tell "go implement
something" apart from "something broke" without parsing output. Non-
zero only on a genuine pipeline failure (compile error exhausted its
retries, lint/test-suite/smoke failure, unparseable review).

--continuous advances through every mechanical transition (a criterion
finishing and the next one's test-writing starting) without stopping,
pausing only at a genuine human pause point.

Usage:
    next_step [--model <model-id>] [--config <path>] [--continuous]
              [--log-level <level>]
"""

import argparse
import subprocess
import sys
from pathlib import Path

from .lib import ai_client, pipeline_lib as lib, render, tools, verbosity

log = verbosity.get_logger(__name__)

DEFAULT_MODEL = "opencode:gpt-5.4-mini"


# Final safety cap after signal-extraction (see lib.extract_test_output_signal)
# - a heuristic filter can still let through a lot if a run genuinely has
# many failures, so this is a backstop, not the primary noise control.
RED_CHECK_OUTPUT_TAIL_CHARS = 4000

# A frame whose freshly-written test came back green immediately, for a
# criterion that did NOT originate from the initial push_ticket seeding
# (origin != "ticket" - i.e. origin="validate-missed" or "review", both
# pushed *because* an independent check just judged this unsatisfied).
# Distinct from "test-written": that status means a confirmed-red test
# is waiting for implementation; this one means the test is green but
# nobody has confirmed that's legitimate rather than a false green (the
# test doesn't actually exercise the described behavior). See
# do_write_test/do_await_green_unconfirmed for why this distinction
# exists - without it, a false green here loops forever: WRITE_TEST
# writes a weak test -> green -> auto-popped as done -> TICKET_VALIDATE's
# safety-net re-narrow still finds the same gap (nothing was ever
# implemented) -> pushes it right back as a new validate-missed frame ->
# repeat, silently burning AI calls under --continuous with no human
# ever seeing it.
GREEN_UNCONFIRMED_STATUS = "green-unconfirmed"


def do_await_impl(frame: "lib.CriterionFrame", test_result: subprocess.CompletedProcess | None = None) -> None:
    render.print_line()
    render.print_line("-- Test written. Implement now:")
    render.print_line(f"   {frame.test_file} :: {frame.test_name}")
    render.print_line(f"   Criterion: {frame.criterion}")
    if test_result is not None:
        output = ((test_result.stdout or "") + (test_result.stderr or "")).strip()
        if output:
            # test_filter_cmd's default isn't scoped to a single test
            # binary/file (it's a name filter applied across every test
            # file in the project - see toolchains.py), so raw output is
            # often mostly irrelevant "running tests\other_file.rs (...)"
            # noise. Filter to the toolchain's own signal pattern first;
            # only fall back to a blind tail if that heuristic somehow
            # matched nothing.
            signal = lib.extract_test_output_signal(output, lib.get_toolchain().test_output_signal_pattern)
            render.print_line()
            render.print_line("-- Red test output (why it currently fails):")
            render.print_line(signal[-RED_CHECK_OUTPUT_TAIL_CHARS:])
    render.print_line(f"-- Token usage: {ai_client.usage}")
    sys.exit(0)


def do_await_green_unconfirmed(frame: "lib.CriterionFrame") -> None:
    render.print_line()
    render.print_line("-- Test passed immediately, without any changes - unconfirmed:")
    render.print_line(f"   {frame.test_file} :: {frame.test_name}")
    render.print_line(f"   Criterion: {frame.criterion}")
    render.print_line(f"   Origin: {frame.origin}")
    render.print_line()
    render.print_line(
        f"   This criterion came from {frame.origin!r}, not the ticket's initial "
        f"criteria - it exists specifically because an earlier check just judged "
        f"it unsatisfied. A test passing this easily is much more likely a weak "
        f"test (not exercising the described behavior) than the gap genuinely "
        f"having disappeared. Either:"
    )
    render.print_line("     - inspect the test and fix it if it's not testing the right thing,")
    render.print_line("       then run 'next_step' again (a now-red test resumes the normal flow), or")
    render.print_line(
        "     - if you're confident the behaviour really is already present, run "
        "'next_step --accept-green' to accept it and move on."
    )
    render.print_line(f"-- Token usage: {ai_client.usage}")
    sys.exit(0)


def do_write_test(stack: list, frame: "lib.CriterionFrame", model: str, commands: dict) -> None:
    """
    Writes (or retries writing) frame's test, gated on compile success.
    A red test is always a pause point (do_await_impl, never returns).

    A green test's handling depends on origin:
      - origin="ticket" (the ticket's own initial criteria): trusted -
        marks the frame done and returns, so the caller's phase-detection
        loop re-dispatches it straight to POP without a separate
        invocation. Legitimate here because one criterion's
        implementation can easily satisfy a sibling criterion as a side
        effect within the same initial pass.
      - any other origin (validate-missed/review - pushed *because* an
        independent check already judged this unsatisfied): NOT trusted.
        An immediate green here is much more likely a weak test than the
        gap having genuinely disappeared - see GREEN_UNCONFIRMED_STATUS's
        module-level comment for why auto-trusting it created a boundless
        loop. Pauses at do_await_green_unconfirmed instead (always exits,
        including under --continuous).
    """
    file_path, test_name, compile_result = lib.run_test_for_criterion_with_compile_retry(
        frame.criterion, frame.plan_context, model, commands, ticket_id=frame.ticket
    )
    if compile_result is None or compile_result.returncode != 0:
        exit_code = compile_result.returncode if compile_result is not None else "unknown"
        lib.die_with_log(
            "test-criterion",
            f"Test does not compile after retries (exit {exit_code}). See output above.",
            criterion=frame.criterion,
            ticket=frame.ticket,
        )

    # quiet=True: a red result here is the expected outcome, not a real
    # error, and do_await_impl below prints its own filtered version of
    # this exact output - logging the raw dump at ERROR too would just
    # be the same content twice, with the noisier copy first.
    red_result = lib.run_scoped_test(test_name, commands, "red check", quiet=True)
    if red_result.returncode == 0:
        if frame.origin == "ticket":
            log.info(
                "-- Test passed without implementation - this criterion's "
                "gap didn't reproduce."
            )
            frame.status = "done"
            lib.save_stack(stack)
            return
        frame.test_file = file_path
        frame.test_name = test_name
        frame.status = GREEN_UNCONFIRMED_STATUS
        lib.save_stack(stack)
        do_await_green_unconfirmed(frame)

    frame.test_file = file_path
    frame.test_name = test_name
    frame.status = "test-written"
    lib.save_stack(stack)
    do_await_impl(frame, red_result)


def do_pop(frame: "lib.CriterionFrame", continuous: bool, model: str, commands: dict, config_path: Path) -> None:
    just_popped_ticket = frame.ticket
    just_popped_criterion = frame.criterion
    lib.pop_frame()
    new_stack = lib.load_stack()

    render.print_line()
    render.print_line(f"-- Criterion done: {just_popped_criterion}")

    if not new_stack or new_stack[0].ticket != just_popped_ticket:
        do_ticket_validate(just_popped_ticket, model, commands, config_path)
        return

    if not continuous:
        render.print_line(f"-- Next: {new_stack[0].criterion}")
        render.print_line(f"-- Token usage: {ai_client.usage}")
        sys.exit(0)
    # continuous: fall through, letting the caller's loop re-dispatch
    # straight into the new top frame's WRITE_TEST phase.


def do_ticket_validate(ticket_id: str, model: str, commands: dict, config_path: Path) -> None:
    """
    Full ticket-validation gate, run once a ticket's per-criterion
    frames are all popped: fresh re-fetch + re-narrow (safety net for
    criteria the per-criterion gates missed), lint, full test suite,
    smoke test, code review. A CHANGES REQUESTED review or a non-empty
    safety-net re-narrow pushes new frames instead of failing outright -
    next_step is meant to be re-run, not treated as a one-shot gate.

    The very first thing this does is ensure a "validating" sentinel
    frame for ticket_id is on the stack (see lib.ensure_validating_sentinel -
    shared with push_ticket.py's --validate-only, which pushes the same
    sentinel directly without going through a pop first) - every step
    below this point is fallible (network fetch, AI calls, lint, the
    full test suite, smoke test), and the sentinel is what makes a
    failure at any of them resumable: it's only ever removed on an
    APPROVED verdict, so a re-run of `next_step` after a lint/test-suite/
    smoke failure (or a review the model failed to parse) finds the
    sentinel again and retries validation from scratch, instead of the
    ticket's "still needs validating" fact having vanished the moment
    its last real criterion was popped.
    """
    lib.ensure_validating_sentinel(ticket_id)

    render.print_line()
    render.print_line(f"-- All criteria for {ticket_id} done. Running full ticket validation ...")

    ticket_content = lib.fetch_ticket_text(ticket_id)
    tools.write_file_block(str(lib.TICKET_FILE))(ticket_content)

    if lib.PLAN_FILE.is_file():
        plan_text = lib.PLAN_FILE.read_text(encoding="utf-8")
    else:
        plan_text = lib.run_plan_step(ticket_content, model, ticket_id=ticket_id)

    gap_plan_content = lib.run_narrow_step(ticket_content, plan_text, model, ticket_id=ticket_id)
    remaining = lib.extract_acceptance_criteria(gap_plan_content)
    if remaining:
        log.warning(
            "-- Safety-net re-narrow found %d criteria the per-criterion gates "
            "missed. This should not normally happen. Pushing them as new "
            "criteria instead of failing.",
            len(remaining),
        )
        missed_frames = [
            lib.CriterionFrame(
                ticket=ticket_id,
                criterion=criterion,
                plan_context=lib.extract_plan_context_for_criterion(criterion, gap_plan_content),
                test_file=None,
                test_name=None,
                status="pending",
                origin="validate-missed",
            )
            for criterion in remaining
        ]
        lib.push_frames(missed_frames)
        render.print_line()
        render.print_line(
            f"-- Ticket validation's re-narrow found {len(remaining)} criteria the "
            f"per-criterion gates missed. Pushed as new criteria. Run 'next_step' "
            f"to begin addressing them."
        )
        for missed in missed_frames:
            render.print_line(f"   {missed.criterion}")
        render.print_line(f"-- Token usage: {ai_client.usage}")
        sys.exit(0)

    lib.run_lint_gate(commands)

    result = lib.run_command(commands["test_cmd"], "full test suite gate")
    if result.returncode != 0:
        lib.die_with_log(
            "test-suite",
            f"Full test suite fails after all criteria implemented (exit "
            f"{result.returncode}). A criterion's scoped test passing doesn't "
            f"guarantee an earlier criterion's test still does - see output above.",
            ticket=ticket_id,
        )

    smoke_cmd = lib.load_smoke_cmd(config_path)
    lib.run_smoke_gate(smoke_cmd)

    changed_files = lib.git_changed_files()
    if not changed_files:
        lib.die_with_log(
            "review", "No changed files found (git diff/untracked are both empty). Nothing to review.",
            ticket=ticket_id,
        )

    # plan_text (the full original plan), not gap_plan_content: by this
    # point remaining is guaranteed empty (a non-empty one would have
    # exited above), so gap_plan_content's Acceptance Criteria section
    # always reads "nothing left to do" here - useless, misleading scope
    # for the reviewer. plan_text is the actual full ticket scope the
    # implementation was supposed to satisfy, same as the legacy
    # validate-and-review.py's review gate always used.
    verdict, review_text = lib.run_review_gate(changed_files, plan_text, model, ticket_id=ticket_id)

    if verdict == "APPROVED":
        # Validation is genuinely done now - remove the sentinel
        # (lib.ensure_validating_sentinel's counterpart) so a later
        # next_step call doesn't find a stale "still needs validating"
        # marker for a ticket that's already fully approved.
        lib.pop_frame()
        render.print_line()
        render.print_line("-- Summary:")
        render.print_line(f"   Ticket: {ticket_id}")
        render.print_line("   Acceptance criteria: all satisfied")
        render.print_line("   Lint: clean")
        render.print_line("   Test suite: passed")
        render.print_line(f"   Smoke test: {'passed' if smoke_cmd else 'skipped (not configured)'}")
        render.print_line(f"   Files reviewed ({len(changed_files)}): {', '.join(changed_files)}")
        render.print_line("   Code review: APPROVED")
        render.print_line()
        render.print_line(f"-- {ticket_id} fully validated. Success.")
        render.print_line(f"-- Token usage: {ai_client.usage}")
        sys.exit(0)

    do_push_review_findings(ticket_id, review_text)


def do_push_review_findings(ticket_id: str, review_text: str) -> None:
    findings = lib.extract_review_findings(review_text)
    if not findings:
        lib.die_with_log(
            "review",
            "Review verdict was CHANGES REQUESTED but no parseable findings were "
            "found in its output (see output above). Refusing to push zero frames "
            "for a failed review.",
            ticket=ticket_id,
        )
    new_frames = [
        lib.CriterionFrame(
            ticket=ticket_id,
            criterion=f"- [ ] {finding}",
            plan_context=finding,
            test_file=None,
            test_name=None,
            status="pending",
            origin="review",
        )
        for finding in findings
    ]
    lib.push_frames(new_frames)
    render.print_line()
    render.print_line(
        f"-- Review found {len(findings)} issue(s). Pushed as new criteria. "
        f"Run 'next_step' to begin addressing them."
    )
    for new_frame in new_frames:
        render.print_line(f"   {new_frame.criterion}")
    render.print_line(f"-- Token usage: {ai_client.usage}")
    sys.exit(0)


def step(model: str, commands: dict, continuous: bool, config_path: Path, accept_green: bool = False) -> None:
    """
    One pass of phase detection + dispatch. Returns normally only when
    the caller's loop should immediately re-detect and dispatch again
    (a green test cascading into POP, or --continuous advancing into
    the next criterion) - every other path exits the process directly.
    """
    stack = lib.load_stack()
    if not stack:
        render.print_line("-- No work remaining. Stack is empty.")
        sys.exit(0)

    frame = stack[0]
    log.info("-- next_step: ticket=%s status=%s criterion=%s", frame.ticket, frame.status, frame.criterion)

    if frame.status == lib.VALIDATING_STATUS:
        # A prior TICKET_VALIDATE attempt for this ticket died partway
        # through (lint/test-suite/smoke/unparseable review) and left
        # this sentinel behind - re-enter validation directly, no pop
        # needed (there's nothing left to pop; the real criteria are
        # long gone).
        do_ticket_validate(frame.ticket, model, commands, config_path)
        return

    if frame.status == GREEN_UNCONFIRMED_STATUS:
        # Always re-verify real state rather than trusting the stored
        # status (same principle as every other phase) - the human may
        # have fixed the test in the meantime, in which case it's now
        # properly red and this becomes a normal AWAIT_IMPL case.
        result = lib.run_scoped_test(frame.test_name, commands, "green-unconfirmed re-check", quiet=True)
        if result.returncode != 0:
            frame.status = "test-written"
            lib.save_stack(stack)
            do_await_impl(frame, result)
            return
        if accept_green:
            log.info(
                "-- --accept-green: accepting %s as satisfied despite origin=%r.",
                frame.criterion, frame.origin,
            )
            frame.status = "done"
            lib.save_stack(stack)
            return
        do_await_green_unconfirmed(frame)
        return

    if frame.status == "pending":
        do_write_test(stack, frame, model, commands)
        return

    if frame.status == "test-written":
        if frame.test_file is None or frame.test_name is None:
            log.warning("-- Frame is test-written but missing test_file/test_name - retrying WRITE_TEST.")
            do_write_test(stack, frame, model, commands)
            return
        result = lib.run_scoped_test(frame.test_name, commands, "phase check", quiet=True)
        if result.returncode == 0:
            frame.status = "done"
            lib.save_stack(stack)
            return
        do_await_impl(frame, result)
        return

    # frame.status == "done" - shouldn't normally be seen fresh off disk
    # (WRITE_TEST/the phase-check above both cascade into this same step()
    # call rather than persisting a "done" frame across invocations), but
    # handled the same way regardless of how we got here.
    do_pop(frame, continuous, model, commands, config_path)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Advance the criteria stack by exactly one step, pausing "
                     "when human input is genuinely required.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
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
        "--continuous",
        action="store_true",
        help="Advance through every mechanical transition without pausing, "
             "stopping only when human input is genuinely required (a red "
             "test awaiting implementation, or the stack going empty).",
    )
    parser.add_argument(
        "--accept-green",
        action="store_true",
        help="Accept the top frame as satisfied if it's currently paused "
             "in the 'green-unconfirmed' state (a validate-missed/review "
             "criterion whose test passed immediately, without any "
             "changes - see the pause message for why that's untrusted by "
             "default). Has no effect if the top frame isn't in that "
             "state. Use this only after confirming the behaviour really "
             "is already present - not as a way to silence the warning.",
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

    config_path = Path(args.config)
    commands = lib.load_pipeline_config(config_path)

    while True:
        step(args.model, commands, args.continuous, config_path, accept_green=args.accept_green)


if __name__ == "__main__":
    main()

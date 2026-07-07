#!/usr/bin/env python3
"""
next_step - advance the criteria stack by exactly one step, pausing
whenever human input (implementation) is genuinely required. The main
orchestrator of the criteria-stack pipeline; run `push_ticket <id>`
once to seed the stack, then run this repeatedly until it reports no
work remaining.

No ticket_id argument - the ticket is read from the stack itself.

Phase detection (re-run fresh from real state at the top of every
step - the frame's `status` field is a hint, never a trust boundary).
A criterion almost always tracks exactly one test, but can track
several (test_files/test_names are parallel lists) when its own
behavior genuinely spans call paths that can't share one test function
- see test-criterion.prompt.md's Step 3. Everything below describes the
general N-test case; N=1 behaves exactly as it always has.

  stack empty                              -> done, nothing to do
  top frame status == "validating"         -> TICKET_VALIDATE (a prior
                                               attempt for this ticket
                                               died partway through;
                                               resume it directly)
  top frame status == "green-unconfirmed"  -> re-run every scoped test
                                               (recheck_test_frame):
    any still red                          -> becomes a normal
                                               test-written/AWAIT_IMPL case
                                               (someone fixed it)
    all green, nothing left unconfirmed    -> mark done, re-detect (POP)
    all green, some still unconfirmed,
      --accept-green passed                -> mark done, re-detect (POP)
    all green, some still unconfirmed,
      no --accept-green                    -> pause again (always exits)
  top frame status in ("pending",
    "awaiting-manual-impl"),
    verification == "manual"                -> MANUAL_CRITERION (no test
                                               involved at all - see below)
  top frame status == "pending"            -> WRITE_TEST
  top frame status == "test-written",
    missing test_files/test_names          -> WRITE_TEST (retry)
  top frame status == "test-written"       -> re-run every scoped test
                                               (recheck_test_frame):
    any still red                          -> AWAIT_IMPL (always pauses)
    all green, nothing unconfirmed         -> mark done, re-detect (POP)
    all green, something unconfirmed       -> becomes green-unconfirmed
                                               (see above)
  top frame status == "done"               -> POP

A test that comes back green immediately, the very first time WRITE_TEST
writes it, is trusted unconditionally only when the criterion is
origin="ticket" (the ticket's own initial criteria - one criterion's
implementation can legitimately satisfy a sibling as a side effect). For
any other origin (validate-missed/review - pushed *because* an
independent check already judged the criterion unsatisfied), that test
is untrusted by default and recorded in frame.unconfirmed_tests: much
more likely a weak test than the gap having genuinely disappeared, and
auto-trusting it here is what turns into a boundless validate ->
false-green -> pop -> re-validate loop, silently burning AI calls under
--continuous with no human ever seeing it. This check happens exactly
once, at the moment a test is first observed (do_write_test) - if other
tests in the same group are still red, the group proceeds to AWAIT_IMPL
regardless (real work remains either way); the unconfirmed name(s) only
ever actually block popping once every test in the group is green.
frame.unconfirmed_tests only ever shrinks after that first observation
(a name is dropped once observed red - real implementation happened, so
it's no longer an untested free pass) - --accept-green explicitly
confirms whatever's still in it and moves on.

A frame tagged verification="manual" (documentation, config, CI changes
- anything narrow-plan.prompt.md's Step 4 judged as having no meaningful
red/green - see extract_verification_mode) skips WRITE_TEST/AWAIT_IMPL
entirely: there's no test to write. Its own mechanical floor is weaker
by necessity - do the file(s) named in the criterion/plan_context
(extract_referenced_paths) actually show up in git_changed_files()? A
match there is real, direct evidence (unlike a test, it can't be
trivially gamed the way a weak test's false green can, so - unlike
green-unconfirmed - it's trusted regardless of origin) and pops the
frame immediately, even on the very first look, before ever pausing. No
match pauses (always exits), same shape as AWAIT_IMPL. If no file could
be identified at all, there's nothing to mechanically check - popping
requires an explicit --accept-manual, the same escape-hatch shape as
--accept-green, rather than ever silently trusting a criterion this
pipeline has no way to verify.

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

# A verification="manual" frame (see extract_verification_mode) that's
# been paused at least once already - distinguishes "first look, not
# checked yet" (status="pending") from "already told the human to make
# this change" only for the pause message's wording; the mechanical
# floor check in do_manual_criterion runs identically either way, same
# principle as every other phase (status is a hint, never a trust
# boundary).
MANUAL_PENDING_STATUS = "awaiting-manual-impl"


def do_await_impl(
    frame: "lib.CriterionFrame", test_results: list[tuple[str, str, subprocess.CompletedProcess]]
) -> None:
    """
    test_results: one (file, name, CompletedProcess) tuple per test in
    the frame's group, same order as test_files/test_names - the caller
    (do_write_test or recheck_test_frame) already ran these itself, so
    this only renders what's already known, never re-runs anything.
    Almost always a single red entry (the common N=1 case); more than
    one only for a criterion needing multiple tracked tests (see
    test-criterion.prompt.md's Step 3).
    """
    render.print_line()
    red = [(f, n, r) for f, n, r in test_results if r.returncode != 0]
    green = [(f, n, r) for f, n, r in test_results if r.returncode == 0]
    if len(test_results) == 1:
        render.print_line("-- Test written. Implement now:")
    else:
        render.print_line(
            f"-- {len(red)} of {len(test_results)} test(s) still to implement:"
        )
    for f, n, _ in red:
        render.print_line(f"   {f} :: {n}")
    if green:
        render.print_line("   Already passing (no action needed on these):")
        for f, n, _ in green:
            tag = " - unconfirmed, weak-test risk" if n in frame.unconfirmed_tests else ""
            render.print_line(f"     {f} :: {n}{tag}")
    render.print_line(f"   Criterion: {frame.criterion}")
    for f, n, r in red:
        output = ((r.stdout or "") + (r.stderr or "")).strip()
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
            label = f" for {n}" if len(test_results) > 1 else ""
            render.print_line(f"-- Red test output{label} (why it currently fails):")
            render.print_line(signal[-RED_CHECK_OUTPUT_TAIL_CHARS:])
    render.print_line(f"-- Token usage: {ai_client.usage}")
    sys.exit(0)


def do_await_green_unconfirmed(frame: "lib.CriterionFrame") -> None:
    """
    Every test in frame.test_names is currently green, but frame.
    unconfirmed_tests (a non-empty subset, possibly all of them) was
    never actually confirmed legitimate - see recheck_test_frame/
    do_write_test for how a test lands here. Lists every test, tagging
    which specific one(s) are the actual concern, since a mixed group
    can have some already-trusted tests (origin="ticket", or a
    previously-red test since fixed by real implementation) alongside
    still-unconfirmed ones.
    """
    render.print_line()
    unconfirmed = set(frame.unconfirmed_tests)
    plural = len(unconfirmed) != 1
    render.print_line(
        f"-- Test(s) passed, but {'one has' if not plural else 'some have'} "
        f"not been confirmed legitimate:"
    )
    for file_path, name in zip(frame.test_files, frame.test_names):
        tag = " - UNCONFIRMED (passed without any implementation)" if name in unconfirmed else " - confirmed"
        render.print_line(f"   {file_path} :: {name}{tag}")
    render.print_line(f"   Criterion: {frame.criterion}")
    render.print_line(f"   Origin: {frame.origin}")
    render.print_line()
    render.print_line(
        f"   This criterion came from {frame.origin!r}, not the ticket's initial "
        f"criteria - it exists specifically because an earlier check just judged "
        f"it unsatisfied. The UNCONFIRMED test(s) above passed this easily, which "
        f"is much more likely a weak test (not exercising the described behavior) "
        f"than the gap genuinely having disappeared. Either:"
    )
    render.print_line("     - inspect the unconfirmed test(s) and fix them if they're not testing the right thing,")
    render.print_line("       then run 'next_step' again (a now-red test resumes the normal flow), or")
    render.print_line(
        "     - if you're confident the behaviour really is already present, run "
        "'next_step --accept-green' to accept every unconfirmed test above and move on."
    )
    render.print_line(f"-- Token usage: {ai_client.usage}")
    sys.exit(0)


def do_await_manual_impl(frame: "lib.CriterionFrame", paths: list[str]) -> None:
    render.print_line()
    render.print_line("-- Manual change needed (not test-verifiable):")
    render.print_line(f"   Criterion: {frame.criterion}")
    if frame.plan_context:
        render.print_line(f"   Context: {frame.plan_context}")
    if paths:
        render.print_line(f"   Expecting changes to: {', '.join(paths)}")
        render.print_line(
            "   Make the change, then run 'next_step' again - it checks whether "
            "those file(s) actually changed before marking this done."
        )
    else:
        render.print_line(
            "   No specific file could be identified from this criterion, so there's "
            "nothing to mechanically check here. Make the change, then run "
            "'next_step --accept-manual' to confirm it's done."
        )
    render.print_line(f"-- Token usage: {ai_client.usage}")
    sys.exit(0)


def do_manual_criterion(stack: list, frame: "lib.CriterionFrame", accept_manual: bool) -> None:
    """
    Handles a verification="manual" frame - a criterion that isn't
    expressible as a red/green test (documentation, config, CI changes -
    see extract_verification_mode). There's no scoped test to mechanically
    re-check the way every other phase can, so the floor here is
    different: does git_changed_files() show the file(s) this criterion/
    plan_context actually names (extract_referenced_paths)? That's real,
    direct evidence - the exact referenced file changed - not a proxy a
    lazy edit could trivially satisfy the way a weak test's false green
    can, so unlike GREEN_UNCONFIRMED_STATUS this doesn't need an
    origin-based trust distinction: a match is trusted regardless of why
    the frame was pushed, even on the very first look before ever pausing
    (mirrors do_write_test's origin="ticket" case - one criterion's
    change can satisfy another as a side effect).

    If no file could be identified at all, there is genuinely nothing to
    check mechanically - popping requires an explicit --accept-manual,
    same escape-hatch shape as --accept-green, rather than ever silently
    trusting a criterion this pipeline has no way to verify.
    """
    paths = lib.extract_referenced_paths(f"{frame.criterion}\n{frame.plan_context}")
    mechanically_confirmed = bool(paths) and bool(set(paths) & set(lib.git_changed_files()))
    if mechanically_confirmed or accept_manual:
        frame.status = "done"
        lib.save_stack(stack)
        return
    frame.status = MANUAL_PENDING_STATUS
    lib.save_stack(stack)
    do_await_manual_impl(frame, paths)


def do_write_test(stack: list, frame: "lib.CriterionFrame", model: str, commands: dict) -> None:
    """
    Writes (or retries writing) frame's test(s), gated on compile
    success. Almost always exactly one test; more than one only when
    the criterion needed genuinely separate tests (test-criterion.
    prompt.md's Step 3). At least one test still red is always a pause
    point (do_await_impl, never returns) - real work remains regardless
    of how many siblings are already green.

    Each test's green-at-write-time handling depends on origin:
      - origin="ticket" (the ticket's own initial criteria): trusted
        unconditionally. Legitimate here because one criterion's
        implementation can easily satisfy a sibling criterion as a side
        effect within the same initial pass.
      - any other origin (validate-missed/review - pushed *because* an
        independent check already judged this unsatisfied): NOT trusted.
        A test passing this easily is much more likely weak than the
        gap having genuinely disappeared - see GREEN_UNCONFIRMED_STATUS's
        module-level comment for why auto-trusting it created a boundless
        loop. Recorded in frame.unconfirmed_tests rather than gating
        anything immediately if other tests in the group are still red
        (there's real work either way); only actually pauses here if
        EVERY test in the group is already green with none of them
        trusted (see the branches below). This origin check happens
        exactly once, right here, at the moment each test is first
        observed - never re-applied on a later resume (recheck_test_frame
        trusts any test that goes red-then-green after this point, since
        that's necessarily real implementation work, not an untested
        free pass).

    Once every test compiles (before any red/green dispatch), an
    independent, advisory-only test-quality review runs unconditionally
    (see run_test_quality_review) - never gates anything here, just
    printed immediately and logged if it flags a concern, so it's still
    visible even on a path that doesn't pause (origin="ticket", every
    test already green-and-done).
    """
    file_paths, test_names, compile_result = lib.run_test_for_criterion_with_compile_retry(
        frame.criterion, frame.plan_context, model, commands, ticket_id=frame.ticket,
        existing_test_refs=frame.existing_test_refs,
    )
    if compile_result is None or compile_result.returncode != 0:
        exit_code = compile_result.returncode if compile_result is not None else "unknown"
        lib.die_with_log(
            "test-criterion",
            f"Test does not compile after retries (exit {exit_code}). See output above.",
            criterion=frame.criterion,
            ticket=frame.ticket,
        )

    # Advisory-only, never gates anything below - printed immediately so
    # it's visible even if this criterion turns out not to pause at all
    # (origin="ticket", every test green-and-done, under --continuous or
    # otherwise).
    flagged = lib.run_test_quality_review(
        frame.criterion, frame.plan_context, file_paths, test_names,
        frame.existing_test_refs, model, ticket_id=frame.ticket,
    )
    if flagged:
        lib.log_event(
            "review-test-quality", "flagged", error=flagged,
            criterion=frame.criterion, ticket=frame.ticket,
        )
        render.print_line()
        render.print_line("-- Test-quality review flagged a concern (advisory, not blocking):")
        render.print_line(flagged)

    frame.test_files = file_paths
    frame.test_names = test_names

    # quiet=True: a red result here is the expected outcome, not a real
    # error, and do_await_impl below prints its own filtered version of
    # this exact output - logging the raw dump at ERROR too would just
    # be the same content twice, with the noisier copy first.
    results = lib.run_scoped_tests(test_names, commands, "red check", quiet=True)
    test_results = list(zip(file_paths, test_names, results))
    red_names = [n for n, r in zip(test_names, results) if r.returncode != 0]
    green_names = [n for n, r in zip(test_names, results) if r.returncode == 0]
    # Ticket-origin green is always trusted, so nothing from it is ever
    # "unconfirmed" - every other origin's green needs confirmation.
    unconfirmed = [] if frame.origin == "ticket" else green_names

    if not red_names and not unconfirmed:
        # Every test is green, and none needed confirmation (only
        # possible for origin="ticket" - see above).
        log.info(
            "-- Test(s) passed without implementation - this criterion's "
            "gap didn't reproduce."
        )
        frame.status = "done"
        frame.unconfirmed_tests = []
        lib.save_stack(stack)
        return

    if not red_names and unconfirmed:
        # Every test is green, but at least one needs confirmation.
        frame.status = GREEN_UNCONFIRMED_STATUS
        frame.unconfirmed_tests = unconfirmed
        lib.save_stack(stack)
        do_await_green_unconfirmed(frame)
        return

    # At least one test is still red - real work remains regardless of
    # how many siblings are already (trusted or unconfirmed) green.
    frame.status = "test-written"
    frame.unconfirmed_tests = unconfirmed
    lib.save_stack(stack)
    do_await_impl(frame, test_results)


def recheck_test_frame(
    stack: list, frame: "lib.CriterionFrame", commands: dict, accept_green: bool
) -> None:
    """
    Re-verifies a frame already past its initial WRITE_TEST look (status
    "test-written" or GREEN_UNCONFIRMED_STATUS) by re-running every test
    in its group fresh - status is a hint, never a trust boundary, same
    principle as every other phase. Shared by both of step()'s resume
    branches (see below) since the logic converges regardless of which
    one the frame arrived from: origin-based trust was already decided
    once, at write time (do_write_test); this only ever shrinks
    frame.unconfirmed_tests (dropping any name now found red - it's no
    longer a suspiciously-easy green, it's just a normal red test again),
    never re-derives it from origin.
    """
    results = lib.run_scoped_tests(frame.test_names, commands, "phase check", quiet=True)
    test_results = list(zip(frame.test_files, frame.test_names, results))
    red_names = [n for n, r in zip(frame.test_names, results) if r.returncode != 0]
    frame.unconfirmed_tests = [n for n in frame.unconfirmed_tests if n not in red_names]

    if red_names:
        frame.status = "test-written"
        lib.save_stack(stack)
        do_await_impl(frame, test_results)
        return

    # Every test is green now.
    if not frame.unconfirmed_tests:
        frame.status = "done"
        lib.save_stack(stack)
        return

    if accept_green:
        log.info(
            "-- --accept-green: accepting %s as satisfied despite origin=%r "
            "(unconfirmed test(s): %s).",
            frame.criterion, frame.origin, ", ".join(frame.unconfirmed_tests),
        )
        frame.status = "done"
        frame.unconfirmed_tests = []
        lib.save_stack(stack)
        return

    frame.status = GREEN_UNCONFIRMED_STATUS
    lib.save_stack(stack)
    do_await_green_unconfirmed(frame)


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
                test_files=None,
                test_names=None,
                status="pending",
                origin="validate-missed",
                verification=lib.extract_verification_mode(criterion),
                existing_test_refs=lib.extract_existing_test_refs(criterion),
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
            test_files=None,
            test_names=None,
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


def step(
    model: str, commands: dict, continuous: bool, config_path: Path,
    accept_green: bool = False, accept_manual: bool = False,
) -> None:
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
        # have fixed the test(s) in the meantime, in which case this
        # becomes a normal AWAIT_IMPL case. Shared with the "test-written"
        # resume branch below - see recheck_test_frame.
        recheck_test_frame(stack, frame, commands, accept_green)
        return

    if frame.verification == "manual" and frame.status in ("pending", MANUAL_PENDING_STATUS):
        do_manual_criterion(stack, frame, accept_manual)
        return

    if frame.status == "pending":
        do_write_test(stack, frame, model, commands)
        return

    if frame.status == "test-written":
        if not frame.test_files or not frame.test_names:
            log.warning("-- Frame is test-written but missing test_files/test_names - retrying WRITE_TEST.")
            do_write_test(stack, frame, model, commands)
            return
        recheck_test_frame(stack, frame, commands, accept_green)
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
             "criterion whose test(s) passed immediately, without any "
             "changes - see the pause message for exactly which one(s) and "
             "why that's untrusted by default). Has no effect if the top "
             "frame isn't in that state. Use this only after confirming the behaviour really "
             "is already present - not as a way to silence the warning.",
    )
    parser.add_argument(
        "--accept-manual",
        action="store_true",
        help="Accept the top frame as satisfied if it's currently paused in the "
             "'awaiting-manual-impl' state (a verification=\"manual\" criterion - "
             "documentation, config, etc.). Overrides the mechanical floor check "
             "(did a referenced file actually change) whether or not one could be "
             "identified in the first place - use this after confirming the "
             "change is actually made, whether the automatic check missed it or "
             "there was nothing for it to check at all. Has no effect if the top "
             "frame isn't in that state, or if the automatic check already "
             "confirmed it (nothing to override).",
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
        step(
            args.model, commands, args.continuous, config_path,
            accept_green=args.accept_green, accept_manual=args.accept_manual,
        )


if __name__ == "__main__":
    main()

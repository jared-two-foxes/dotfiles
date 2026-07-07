#!/usr/bin/env python3
"""
implement_step - AI-implement the criteria stack's top frame: make its
one named failing test pass, without touching the stack. The optional
third gesture of the criteria-stack pipeline, slotting into the pause
point next_step deliberately leaves open:

    push_ticket <id>   seed the stack
    next_step          write the failing test, pause at AWAIT_IMPL
    implement_step     (this) turn that red test green
    next_step          re-detect green, pop, continue

Contract: this script's only postcondition is "the top frame's scoped
test passes". It NEVER writes .criteria-stack.json - next_step remains
the sole owner of phase transitions, and re-detects the green test via
its existing status=="test-written" phase check on the very next run.
That single-owner rule is also what makes failure here safe: if the
Implementor exhausts its attempts, the frame is still test-written, the
test is still red, and next_step drops back into AWAIT_IMPL exactly as
if this script had never run - the human implementation path is the
untouched fallback, not a mode this script replaces.

Guard-first (same principle as push_ticket): every precondition is
re-checked from real state before any AI call spends money -
  stack empty                          -> nothing to implement, exit 1
  top frame status != "test-written",
    or missing test_file/test_name     -> run next_step first, exit 1
  scoped test re-run and green         -> nothing to do, run next_step
                                          to pop it, exit 0
  scoped test red                      -> proceed

Implement loop (bounded self-correction, mirroring pipeline_lib's
run_test_for_criterion_with_compile_retry - the legacy resolve-ticket
pipeline was single-shot here, "no second attempt"; this trades that
fail-fast behaviour for the same bounded refine loop the Tester side
already has):

  attempt 1:  fresh implement prompt (frame's own plan_context, not the
              whole gap plan - frames carry their context since push
              time, so the Implementor sees exactly what the Tester saw)
  gate:       build_cmd                -> on failure, feed compile error
                                          back as a fix prompt
  gate:       scoped test green check  -> on failure, feed test output
                                          back as a fix prompt
  attempts 2..N: fix prompt (initial write + every refine share one
              budget of --max-attempts total, not N retries on top)

After EVERY attempt, the named test function is verified byte-for-byte
unchanged against a snapshot taken before the first attempt (brace-
counting extraction, ported from the legacy pipeline). protected_paths
can't do this job: when the test lives inline with the production code
it covers (Rust #[cfg(test)] mod tests - this pipeline's own Tester
default), the test file IS a file the Implementor must legitimately
edit; blocking it entirely makes the task impossible, not safe. The
snapshot check permits the surrounding edits while making test
tampering a hard, mechanical failure. Pipeline bookkeeping files
(.criteria-stack.json and the scratch files) ARE fully write-protected
via protected_paths - the Implementor has no legitimate reason to
touch those.

Level 2 - direct implementation (verification="manual" frames only):
criteria narrow-plan.prompt.md tagged manual (documentation, config, CI
- no meaningful red/green) have no named test to target, so there is
nothing to gate the build-only retry loop on except the build itself.
This mode never touches the stack either, same single-owner rule as
Level 1: next_step's do_manual_criterion is still the sole judge of
whether the criterion is actually satisfied (its own mechanical floor -
did a file this criterion names actually change - or --accept-manual),
run on the very next 'next_step' call same as if a human had made the
change by hand.

Exit codes: 0 when the scoped test is green (whether this run made it
green or found it already green); non-zero on exhausted attempts, a
tampered test, or any genuine pipeline failure. Composable from shell:

    implement_step && next_step --continuous

Usage:
    implement_step [--model <model-id>] [--config <path>]
                   [--max-attempts <n>] [--log-level <level>]
"""

import argparse
import re
import subprocess
import sys
from pathlib import Path

from .lib import ai_client, pipeline_lib as lib, render, tools, verbosity
from .lib.ai_client import AIError, run_with_tools

log = verbosity.get_logger(__name__)

DEFAULT_MODEL = "opencode:gpt-5.4-mini"
DEFAULT_MAX_ATTEMPTS = 3

IMPLEMENT_CRITERION_PROMPT_FILE = lib.PROMPTS_DIR / "implement-criterion.prompt.md"
IMPLEMENT_CRITERION_DIRECT_PROMPT_FILE = lib.PROMPTS_DIR / "implement-criterion-direct.prompt.md"

# Pipeline bookkeeping the Implementor must never write, regardless of
# what the model decides. The named test file is deliberately NOT here -
# see the module docstring; it's guarded by the snapshot check instead.
PROTECTED_PIPELINE_PATHS = {
    str(lib.CRITERIA_STACK_FILE),
    str(lib.TICKET_FILE),
    str(lib.PLAN_FILE),
    str(lib.GAP_PLAN_FILE),
    str(lib.PIPELINE_LOG_FILE),
    str(lib.PIPELINE_CONFIG_FILE),
}


# ---------------------------------------------------------------------------
# Test-tamper guard: snapshot + byte-for-byte verification.
# Ported from the legacy pipeline's _extract_function_block /
# run_implement_for_criterion. Candidates for pipeline_lib once this
# script is accepted; kept local while it's a proposal since nothing
# else uses them.
# ---------------------------------------------------------------------------


def _extract_function_block(content: str, qualified_test_name: str) -> str | None:
    """
    Best-effort extraction of a test function's full source (signature
    through closing brace) by its short name (the last `::`-separated
    segment of qualified_test_name). Brace-counting only works for
    brace-delimited languages (Rust/TS/JS/C++/Java/Go/...); returns None
    for anything that doesn't match (e.g. Python), in which case the
    caller skips the check rather than false-failing on a language this
    can't parse.
    """
    short_name = qualified_test_name.rsplit("::", 1)[-1]
    match = re.search(rf"^[ \t]*.*\b{re.escape(short_name)}\s*\(", content, re.MULTILINE)
    if not match:
        return None
    brace_start = content.find("{", match.end())
    if brace_start == -1:
        return None
    depth = 0
    for i in range(brace_start, len(content)):
        if content[i] == "{":
            depth += 1
        elif content[i] == "}":
            depth -= 1
            if depth == 0:
                return content[match.start():i + 1]
    return None


def verify_test_unchanged(
    test_file: str, qualified_test_name: str, original_block: str | None, criterion: str
) -> None:
    """
    Hard stop if the named test's own source changed. Skipped (with a
    warning at snapshot time, not here) when the original block couldn't
    be extracted - a language this parser can't handle, not evidence of
    tampering.
    """
    if original_block is None:
        return
    if not Path(test_file).is_file():
        lib.die_with_log(
            "implement-criterion",
            f"the test file {test_file} no longer exists after implementation - "
            f"deleting it isn't allowed.",
            criterion=criterion,
        )
    new_block = _extract_function_block(
        Path(test_file).read_text(encoding="utf-8"), qualified_test_name
    )
    if new_block is None:
        lib.die_with_log(
            "implement-criterion",
            f"the named test {qualified_test_name} could not be found in "
            f"{test_file} after implementation - it may have been removed or "
            f"renamed, which isn't allowed.",
            criterion=criterion,
        )
    if new_block != original_block:
        lib.die_with_log(
            "implement-criterion",
            f"the named test {qualified_test_name} in {test_file} was modified "
            f"during implementation, which isn't allowed - only the "
            f"surrounding production code may change.",
            criterion=criterion,
        )


# ---------------------------------------------------------------------------
# Prompt builders. Same shape as pipeline_lib's build_test_criterion_* pair:
# a fresh prompt for attempt 1, a fix prompt threading error output back
# for attempts 2..N.
# ---------------------------------------------------------------------------


def build_implement_criterion_prompt(
    criterion: str, plan_context: str, test_file: str, test_name: str
) -> str:
    instructions = lib.load_prompt_body(IMPLEMENT_CRITERION_PROMPT_FILE)
    return (
        f"{instructions}\n\n---\n\n"
        f"Here is the relevant Implementation Plan context for this "
        f"criterion, extracted from the gap plan - already complete and "
        f"current, no need to read_file it again:\n\n{plan_context}\n\n"
        f"This implementation is for exactly this one acceptance "
        f"criterion, and only this one:\n\n{criterion}\n\n"
        f"The failing test that proves it (must be made to pass without "
        f"modifying it): {test_file} :: {test_name}"
    )


def build_implement_criterion_fix_prompt(
    criterion: str,
    plan_context: str,
    test_file: str,
    test_name: str,
    changed_so_far: list[str],
    failure_kind: str,
    error_output: str,
) -> str:
    instructions = lib.load_prompt_body(IMPLEMENT_CRITERION_PROMPT_FILE)
    changed_list = "\n".join(f"- {p}" for p in changed_so_far) or "- (none recorded)"
    if failure_kind == "compile":
        failure_desc = (
            "but the code does not compile. Fix the compile error with the "
            "smallest targeted change - do not re-implement from scratch or "
            "deviate from the approach already taken unless the error itself "
            "proves that approach can't work."
        )
    else:
        failure_desc = (
            "and it compiles, but the named test still fails. Read the test "
            "output below to understand the gap between what the test expects "
            "and what the implementation does, then make the smallest "
            "targeted fix. Do not weaken or modify the test to make it pass."
        )
    return (
        f"{instructions}\n\n---\n\n"
        f"Here is the relevant Implementation Plan context for this "
        f"criterion, extracted from the gap plan - already complete and "
        f"current, no need to read_file it again:\n\n{plan_context}\n\n"
        f"You already attempted an implementation for exactly this one "
        f"acceptance criterion, and only this one:\n\n{criterion}\n\n"
        f"The failing test that proves it (must be made to pass without "
        f"modifying it): {test_file} :: {test_name}\n\n"
        f"Files changed in the previous attempt (read these first to see "
        f"what was tried):\n{changed_list}\n\n"
        f"{failure_desc}\n\n"
        f"Error output:\n\n```\n{error_output}\n```"
    )


def build_implement_criterion_direct_prompt(criterion: str, plan_context: str) -> str:
    instructions = lib.load_prompt_body(IMPLEMENT_CRITERION_DIRECT_PROMPT_FILE)
    return (
        f"{instructions}\n\n---\n\n"
        f"Here is the relevant Implementation Plan context for this "
        f"criterion, extracted from the gap plan - already complete and "
        f"current, no need to read_file it again:\n\n{plan_context}\n\n"
        f"This implementation is for exactly this one acceptance "
        f"criterion, and only this one:\n\n{criterion}"
    )


def build_implement_criterion_direct_fix_prompt(
    criterion: str, plan_context: str, changed_so_far: list[str], error_output: str
) -> str:
    instructions = lib.load_prompt_body(IMPLEMENT_CRITERION_DIRECT_PROMPT_FILE)
    changed_list = "\n".join(f"- {p}" for p in changed_so_far) or "- (none recorded)"
    return (
        f"{instructions}\n\n---\n\n"
        f"Here is the relevant Implementation Plan context for this "
        f"criterion, extracted from the gap plan - already complete and "
        f"current, no need to read_file it again:\n\n{plan_context}\n\n"
        f"You already attempted an implementation for exactly this one "
        f"acceptance criterion, and only this one:\n\n{criterion}\n\n"
        f"Files changed in the previous attempt (read these first to see "
        f"what was tried):\n{changed_list}\n\n"
        f"but the project does not build. Fix the build error with the "
        f"smallest targeted change - do not re-implement from scratch or "
        f"deviate from the approach already taken unless the error itself "
        f"proves that approach can't work.\n\n"
        f"Error output:\n\n```\n{error_output}\n```"
    )


# ---------------------------------------------------------------------------
# The implement loop.
# ---------------------------------------------------------------------------


def run_implement_direct_with_refine(
    frame: "lib.CriterionFrame",
    model: str,
    commands: dict,
    max_attempts: int,
) -> list[str]:
    """
    Level 2: direct implementation for a verification="manual" frame -
    no named test, so no tamper guard and no scoped-test-green gate, just
    a build-gate retry loop sharing the same one-budget-total shape as
    run_implement_with_refine. Returns the deduplicated list of changed
    files once the build passes; dies via die_with_log on exhausted
    attempts or an AI failure. Does not judge whether the criterion is
    actually satisfied - that's next_step's do_manual_criterion, unchanged,
    run on the next 'next_step' call.
    """
    all_changed: list[str] = []
    last_error: str | None = None
    last_result: subprocess.CompletedProcess | None = None

    for attempt in range(1, max_attempts + 1):
        if attempt == 1:
            prompt = build_implement_criterion_direct_prompt(frame.criterion, frame.plan_context)
        else:
            log.warning(
                "-- Build failed (attempt %d/%d). Feeding the error back to Direct Implementor to fix.",
                attempt - 1, max_attempts,
            )
            prompt = build_implement_criterion_direct_fix_prompt(
                frame.criterion, frame.plan_context, sorted(set(all_changed)), last_error,
            )

        attempt_changed: list[str] = []

        def attempt_step():
            attempt_changed.clear()
            return run_with_tools(
                prompt,
                tools.READ_WRITE_TOOLS,
                tools.make_executor(
                    written_paths=attempt_changed,
                    protected_paths=PROTECTED_PIPELINE_PATHS,
                ),
                "implement-criterion-direct",
                model=model,
                summarize_call=tools.summarize_tool_call,
            )

        try:
            result = lib.run_ai_step_with_retry(
                attempt_step, "implement-criterion-direct", criterion=frame.criterion
            )
        except (AIError, tools.PipelineAbort) as e:
            lib.die_with_log("implement-criterion-direct", str(e), criterion=frame.criterion)
        if not attempt_changed:
            lib.die_with_log(
                "implement-criterion-direct",
                "Direct Implementor finished without writing any files.",
                criterion=frame.criterion,
            )
        all_changed.extend(attempt_changed)
        lib.render_step_output(result.text)

        build_result = lib.run_command(
            commands["build_cmd"], f"build gate (attempt {attempt}/{max_attempts})"
        )
        if build_result.returncode == 0:
            return sorted(set(all_changed))

        last_error = (build_result.stdout or "") + (build_result.stderr or "")
        last_result = build_result
        lib.log_event(
            "implement-criterion-direct", "retry",
            error=f"build failed (attempt {attempt}/{max_attempts})",
            criterion=frame.criterion,
        )

    exit_code = last_result.returncode if last_result is not None else "unknown"
    lib.die_with_log(
        "implement-criterion-direct",
        f"Code does not build after {max_attempts} attempt(s) (exit {exit_code}). See "
        f"output above. The frame is untouched - run 'implement_step' again (perhaps "
        f"with a different --model), or make the change by hand and run 'next_step'.",
        criterion=frame.criterion,
    )


def run_implement_with_refine(
    frame: "lib.CriterionFrame",
    model: str,
    commands: dict,
    max_attempts: int,
) -> list[str]:
    """
    Implement the frame's criterion against its named failing test,
    gated on build + scoped-test-green, feeding failures back to the
    Implementor for a fix attempt - up to max_attempts attempts *total*
    (the initial implement plus every refine counts against one budget).
    Returns the deduplicated list of changed files on success; dies via
    die_with_log on exhausted attempts, a tampered test, or an AI
    failure, leaving the stack untouched in every case.
    """
    test_file, test_name = frame.test_file, frame.test_name

    original_content = (
        Path(test_file).read_text(encoding="utf-8") if Path(test_file).is_file() else None
    )
    original_block = (
        _extract_function_block(original_content, test_name)
        if original_content is not None else None
    )
    if original_block is None:
        log.warning(
            "-- Could not extract the named test's source from %s for the "
            "tamper check (non-brace language, or unexpected layout) - the "
            "byte-for-byte verification will be skipped this run.",
            test_file,
        )

    all_changed: list[str] = []
    failure_kind: str | None = None
    last_error: str | None = None
    last_result: subprocess.CompletedProcess | None = None

    for attempt in range(1, max_attempts + 1):
        if attempt == 1:
            prompt = build_implement_criterion_prompt(
                frame.criterion, frame.plan_context, test_file, test_name
            )
        else:
            log.warning(
                "-- %s failed (attempt %d/%d). Feeding the error back to Implementor to fix.",
                "Build" if failure_kind == "compile" else "Green check",
                attempt - 1, max_attempts,
            )
            prompt = build_implement_criterion_fix_prompt(
                frame.criterion, frame.plan_context, test_file, test_name,
                sorted(set(all_changed)), failure_kind, last_error,
            )

        attempt_changed: list[str] = []

        def attempt_step():
            attempt_changed.clear()
            return run_with_tools(
                prompt,
                tools.READ_WRITE_TOOLS,
                tools.make_executor(
                    written_paths=attempt_changed,
                    protected_paths=PROTECTED_PIPELINE_PATHS,
                ),
                "implement-criterion",
                model=model,
                summarize_call=tools.summarize_tool_call,
            )

        try:
            result = lib.run_ai_step_with_retry(
                attempt_step, "implement-criterion", criterion=frame.criterion
            )
        except (AIError, tools.PipelineAbort) as e:
            lib.die_with_log("implement-criterion", str(e), criterion=frame.criterion)
        if not attempt_changed:
            lib.die_with_log(
                "implement-criterion",
                "Implementor finished without writing any files.",
                criterion=frame.criterion,
            )
        all_changed.extend(attempt_changed)

        # Tamper check after EVERY attempt - a refine attempt is just as
        # capable of "fixing" the test as a first attempt is.
        verify_test_unchanged(test_file, test_name, original_block, frame.criterion)
        lib.render_step_output(result.text)

        build_result = lib.run_command(
            commands["build_cmd"], f"build gate (attempt {attempt}/{max_attempts})"
        )
        if build_result.returncode != 0:
            failure_kind = "compile"
            last_error = (build_result.stdout or "") + (build_result.stderr or "")
            last_result = build_result
            lib.log_event(
                "implement-criterion", "retry",
                error=f"build failed (attempt {attempt}/{max_attempts})",
                criterion=frame.criterion,
            )
            continue

        green_result = lib.run_scoped_test(
            test_name, commands, f"green check (attempt {attempt}/{max_attempts})"
        )
        if green_result.returncode == 0:
            return sorted(set(all_changed))

        failure_kind = "test-red"
        last_error = (green_result.stdout or "") + (green_result.stderr or "")
        last_result = green_result
        lib.log_event(
            "implement-criterion", "retry",
            error=f"test still red (attempt {attempt}/{max_attempts})",
            criterion=frame.criterion,
        )

    exit_code = last_result.returncode if last_result is not None else "unknown"
    what = "Code does not compile" if failure_kind == "compile" else "Test still fails"
    lib.die_with_log(
        "implement-criterion",
        f"{what} after {max_attempts} attempt(s) (exit {exit_code}). See output "
        f"above. The frame is untouched - the test is still red and 'next_step' "
        f"still reports AWAIT_IMPL, so you can implement by hand (or re-run "
        f"implement_step, perhaps with a different --model).",
        criterion=frame.criterion,
    )


def main() -> None:
    parser = argparse.ArgumentParser(
        description="AI-implement the top frame's criterion: make its named "
                     "failing test pass without modifying it. Never touches "
                     "the stack - run 'next_step' afterward to pop.",
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
        "--max-attempts",
        type=int,
        default=DEFAULT_MAX_ATTEMPTS,
        help=f"Total Implementor attempts, initial write + refines sharing "
             f"one budget (default: {DEFAULT_MAX_ATTEMPTS}).",
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

    commands = lib.load_pipeline_config(Path(args.config))

    # ── Guard: re-check every precondition from real state ─────────────────
    stack = lib.load_stack()
    if not stack:
        render.print_line("-- Stack is empty. Nothing to implement. Run 'push_ticket <id>' first.")
        sys.exit(1)

    frame = stack[0]
    log.info(
        "-- implement_step: ticket=%s status=%s verification=%s criterion=%s",
        frame.ticket, frame.status, frame.verification, frame.criterion,
    )

    # ── Level 2: manual-verification frames have no target test, so they
    # branch out here before Level 1's test-written guard even applies.
    # "pending"/"awaiting-manual-impl" mirror next_step.py's own pending
    # and MANUAL_PENDING_STATUS values - duplicated as literals rather
    # than imported, same as this script already does for "test-written".
    if frame.verification == "manual":
        if frame.status not in ("pending", "awaiting-manual-impl"):
            render.print_line(
                f"-- Top frame is a manual-verification criterion but its status "
                f"({frame.status!r}) isn't awaiting implementation. Run 'next_step' first."
            )
            sys.exit(1)

        render.print_line()
        render.print_line("-- Implementing directly (verification=manual, no target test):")
        render.print_line(f"   Criterion: {frame.criterion}")

        changed_files = run_implement_direct_with_refine(
            frame, args.model, commands, args.max_attempts
        )

        render.print_line()
        render.print_line(f"-- Implemented: {frame.criterion}")
        render.print_line(f"   Files changed ({len(changed_files)}): {', '.join(changed_files)}")
        render.print_line(
            "-- Run 'next_step' to check whether this satisfies the criterion and continue."
        )
        render.print_line(f"-- Token usage: {ai_client.usage}")
        return

    if frame.status != "test-written" or frame.test_file is None or frame.test_name is None:
        render.print_line(
            f"-- Top frame is not awaiting implementation (status: {frame.status}"
            f"{'' if frame.test_file else ', no test recorded'}). "
            f"Run 'next_step' to advance it to AWAIT_IMPL first."
        )
        sys.exit(1)

    red_result = lib.run_scoped_test(frame.test_name, commands, "pre-implement red check")
    if red_result.returncode == 0:
        render.print_line(
            f"-- {frame.test_file} :: {frame.test_name} is already green. "
            f"Nothing to implement. Run 'next_step' to pop this criterion."
        )
        sys.exit(0)

    # ── Implement ───────────────────────────────────────────────────────────
    render.print_line()
    render.print_line("-- Implementing:")
    render.print_line(f"   {frame.test_file} :: {frame.test_name}")
    render.print_line(f"   Criterion: {frame.criterion}")

    changed_files = run_implement_with_refine(frame, args.model, commands, args.max_attempts)

    render.print_line()
    render.print_line(f"-- Implemented: {frame.criterion}")
    render.print_line(f"   Test now green: {frame.test_file} :: {frame.test_name}")
    render.print_line(f"   Files changed ({len(changed_files)}): {', '.join(changed_files)}")
    render.print_line("-- Run 'next_step' to pop this criterion and continue.")
    render.print_line(f"-- Token usage: {ai_client.usage}")


if __name__ == "__main__":
    main()

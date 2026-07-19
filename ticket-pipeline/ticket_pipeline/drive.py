#!/usr/bin/env python3
"""
drive - run the next-step / implement-step loop automatically until a
genuine human pause is required.

Each cycle:
  1. Runs `next-step --continuous` to advance through every mechanical
     transition (WRITE_TEST, POP, seeding the next criterion) without
     stopping.
  2. After next-step exits, reads the top frame's status from
     .criteria-stack.json:
     - stack empty          -> all done, exit 0.
     - green-unconfirmed    -> test passed without any implementation;
                               human confirmation needed, exit 0.
     - nothing-written      -> WRITE_TEST produced no file; human
                               decision needed, exit 0.
     - test-written         -> red test awaiting AI implementation;
                               run implement-step (Level 1).
     - awaiting-manual-impl -> manual criterion; run implement-step
                               (Level 2 direct implementation).
     - baseline-confirmed   -> refactor; run implement-step (Level 3).
     - any other status     -> unrecognised, stop safely, exit 0.
  3. After implement-step exits 0, loop back to step 1.

Any subprocess exiting with a non-zero code is a pipeline failure
(exit 1). The --max-cycles guard prevents runaway loops.

Exit codes:
  0  stack empty (all done), or paused at a human-resolvable state
  1  a subprocess failed (next-step or implement-step returned non-zero)

Usage:
    drive [--model <model-id>] [--config <path>] [--max-attempts <n>]
          [--log-level <level>] [--max-cycles <n>]
"""

import argparse
import json
import subprocess
import sys
from pathlib import Path

# Default stack file location - mirrors pipeline_lib.CRITERIA_STACK_FILE.
_CRITERIA_STACK_FILE = Path(".criteria-stack.json")

# Status values implement_step can act on autonomously.
# Duplicated as literals rather than imported to match the project's
# existing convention (implement_step.py does the same for "test-written").
_IMPL_STATUSES = frozenset({
    "test-written",          # Level 1: red test awaiting implementation
    "awaiting-manual-impl",  # Level 2: manual criterion (docs, config, CI)
    "baseline-confirmed",    # Level 3: refactor - safety-net baseline confirmed
})

# Status values only a human can resolve - always stop here.
_HUMAN_PAUSE_STATUSES = frozenset({
    "green-unconfirmed",  # test passed without any implementation; confirm legitimacy
    "nothing-written",    # WRITE_TEST produced no file; decide if criterion is met
})


def _top_frame_status() -> str | None:
    """
    Return the top frame's status field from .criteria-stack.json, or None
    if the stack is empty or the file is absent. Reads directly from disk
    rather than importing pipeline_lib so this module stays a plain
    subprocess orchestrator (same principle as prep_ticket.py).
    """
    if not _CRITERIA_STACK_FILE.is_file():
        return None
    text = _CRITERIA_STACK_FILE.read_text(encoding="utf-8").strip()
    if not text:
        return None
    try:
        raw = json.loads(text)
    except json.JSONDecodeError:
        return None
    if not raw:
        return None
    return raw[0].get("status")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Drive the next-step / implement-step loop until manual input is required.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument(
        "--model",
        default=None,
        help="Model ID forwarded to both next-step and implement-step.",
    )
    parser.add_argument(
        "--config",
        default=None,
        help="Path to .dev-pipeline.toml, forwarded to both subcommands.",
    )
    parser.add_argument(
        "--max-attempts",
        type=int,
        default=None,
        help="implement-step --max-attempts: total Implementor attempts per criterion, initial write + refines sharing one budget.",
    )
    parser.add_argument(
        "--log-level",
        default="info",
        choices=["trace", "debug", "info", "warning", "error", "critical"],
        help="Console verbosity forwarded to both subcommands (default: info).",
    )
    parser.add_argument(
        "--max-cycles",
        type=int,
        default=None,
        help="Hard cap on next-step + implement-step cycles (safety valve; "
             "default: unlimited).",
    )
    args = parser.parse_args()

    # Build base argument lists for each subcommand.
    next_step_base = [sys.executable, "-m", "ticket_pipeline.next_step", "--continuous"]
    impl_base = [sys.executable, "-m", "ticket_pipeline.implement_step"]
    for cmd in (next_step_base, impl_base):
        if args.model:
            cmd += ["--model", args.model]
        if args.config:
            cmd += ["--config", args.config]
        cmd += ["--log-level", args.log_level]
    if args.max_attempts is not None:
        impl_base += ["--max-attempts", str(args.max_attempts)]

    cycle = 0

    while True:
        cycle += 1
        if args.max_cycles is not None and cycle > args.max_cycles:
            print(f"\n-- Hit --max-cycles ({args.max_cycles}). Stopping.")
            return

        cycle_label = f"{cycle}/{args.max_cycles}" if args.max_cycles else str(cycle)
        print(f"\n=== drive: cycle {cycle_label} - next-step ===", flush=True)

        rc = subprocess.run(next_step_base).returncode
        if rc != 0:
            print(f"\n>>> drive FAILED: next-step exited {rc}.", file=sys.stderr)
            sys.exit(1)

        status = _top_frame_status()

        if status is None:
            print("\n>>> drive DONE: stack is empty - all criteria complete.")
            return

        if status in _HUMAN_PAUSE_STATUSES:
            print(
                f"\n>>> drive PAUSED: top frame status is {status!r} - "
                f"human input required. See next-step output above."
            )
            return

        if status not in _IMPL_STATUSES:
            # Unknown or unexpected status (e.g. "pending" that --continuous
            # didn't advance, "done" that wasn't popped, etc.) - stop safely
            # rather than looping blindly.
            print(
                f"\n>>> drive PAUSED: top frame has unrecognised status "
                f"{status!r}. Run 'next-step' directly to inspect."
            )
            return

        print(f"\n=== drive: cycle {cycle_label} - implement-step ({status}) ===", flush=True)

        rc = subprocess.run(impl_base).returncode
        if rc != 0:
            print(f"\n>>> drive FAILED: implement-step exited {rc}.", file=sys.stderr)
            sys.exit(1)

        # implement-step exited 0: the criterion's test is now green (or the
        # manual/refactor implementation completed). Loop back to next-step to
        # pop the frame and advance.


if __name__ == "__main__":
    main()

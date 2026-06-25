#!/usr/bin/env python3
"""
tdd-pipeline - single-shot TDD pipeline: ticket -> plan -> tests ->
implementation -> review, with hard gates at every step.

This is a single attempt, not a loop at the pipeline level. Every gate
either passes or the pipeline dies immediately with a reason on stderr -
there is no retry, no re-prompting, and no second implementation
attempt. If a gate fails, fix the underlying issue (plan, prompt, or
code) and re-run from scratch.

Each AI step uses a local tool layer (see tools.py: read_file, list_dir,
write_file - no MCP) instead of pre-injected file content. The model
reads and writes the workspace directly through these tools; this
script never parses file content out of response text. That tool-call
round trip (model calls a tool, gets a result, decides what to do next)
is not the kind of loop ruled out above - it's turn-taking within one
step, not a retry of a step that already finished, and has no fixed
turn cap (see ai_client.run_with_tools).

Pipeline:
  1. Fetch ticket from Linear.
  2. Generate a TDD plan from the ticket (model reads/writes via tools).
  3. Generate failing tests from the plan (model reads/writes via tools).
  4. Gate: tests must compile.
  5. Gate: tests must be judged an adequate encoding of the acceptance
     criteria (independent of pass/fail) - read-only step.
  6. Run tests. If green, the ticket's tests already pass against
     existing code - report success and stop here.
  7. If red, generate an implementation against the plan and the
     failing tests (test files are write-protected during this step).
  8. Gate: code must compile.
  9. Gate: tests must now pass (no second implementation attempt if not).
  10. Gate: code review must return APPROVED - read-only step.
  11. Success.

The step logic (prompt builders, run_with_tools call shapes, the gates
themselves) lives in pipeline_lib.py, shared with check-ticket.py and
resolve-ticket.py - this script is just the argparse/main() wiring for
the plan -> test -> implement -> review sequence. resolve-ticket.py
reuses the same step functions for its own continuation from a fresh
validate step rather than duplicating this flow.

Build/test commands are read from a project-local TOML config (see
--config) so this isn't Rust/cargo-specific at the tooling level, even
though the default commands and the prompts' assumptions lean Rust today.

Usage:
    tdd-pipeline <ticket-id> [--model <model-id>] [--config <path>]
"""

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import ai_client  # noqa: E402
from ai_client import DEFAULT_MODEL  # noqa: E402
import pipeline_lib as lib  # noqa: E402
import tools  # noqa: E402
import verbosity  # noqa: E402

log = verbosity.get_logger(__name__)

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Single-shot TDD pipeline: ticket -> plan -> tests -> "
                     "implementation -> review.",
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

    commands = lib.load_pipeline_config(Path(args.config))

    # ── Step 1: Fetch ticket ────────────────────────────────────────────────
    ticket_text = lib.fetch_ticket_text(args.ticket_id)
    tools.write_file_block(str(lib.TICKET_FILE))(ticket_text)

    # ── Step 2: Plan (ticket embedded in prompt; plan text returned) ──────
    plan_text = lib.run_plan_step(ticket_text, model)

    # ── Step 3: Tests (model reads plan, writes test files, via tools) ────
    test_files = lib.run_test_step(plan_text, model)

    # ── Step 4: Gate - tests compile ───────────────────────────────────────
    result = lib.run_command(commands["test_compile_cmd"], "test compile gate")
    if result.returncode != 0:
        lib.die(f"Tests do not compile (exit {result.returncode}). See output above.")

    # ── Step 5: Gate - tests adequately encode the acceptance criteria ────
    lib.run_test_coverage_gate(test_files, plan_text, model)

    # ── Step 6: Run tests - green means done ───────────────────────────────
    result = lib.run_command(commands["test_cmd"], "initial test run")
    if result.returncode == 0:
        log.info("\n-- Tests already pass against existing code. Success.")
        log.info("-- Token usage: %s", ai_client.usage)
        return

    # ── Step 7: Implement (test files write-protected) ────────────────────
    changed_files = lib.run_implement_step(test_files, plan_text, model)

    # ── Step 8: Gate - code compiles ────────────────────────────────────────
    result = lib.run_command(commands["build_cmd"], "build gate")
    if result.returncode != 0:
        lib.die(f"Code does not compile (exit {result.returncode}). See output above.")

    # ── Step 9: Gate - tests pass (no second implementation attempt) ──────
    result = lib.run_command(commands["test_cmd"], "post-implementation test run")
    if result.returncode != 0:
        lib.die(
            f"Tests still fail after implementation (exit {result.returncode}). "
            f"This is a single-shot pipeline - no second attempt. See output above."
        )

    # ── Step 10: Gate - code review ─────────────────────────────────────────
    lib.run_review_gate(changed_files, plan_text, model)

    # ── Step 11: Success ─────────────────────────────────────────────────────
    log.info("\n-- Implementation complete, tests pass, review approved. Success.")
    log.info("-- Token usage: %s", ai_client.usage)


if __name__ == "__main__":
    main()

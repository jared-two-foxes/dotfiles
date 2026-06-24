#!/usr/bin/env python3
"""
check-ticket - Fetch a Linear ticket, run the plan prompt, then narrow the
plan down to whatever the codebase doesn't satisfy yet.

Always non-interactive: the planner self-clarifies any ambiguity from
ticket context rather than asking. Any failure (missing command, missing
file, non-zero exit/HTTP error from the backend) aborts immediately with
a reason on stderr - there is no fallback prompting.

Report-only: this script always renders the narrower's gap plan and
exits 0 regardless of whether any criteria remain - it never branches on
the outcome itself, just reports it (no remaining criteria means the
ticket is already fully implemented; any remaining criteria means it
isn't). It shares the narrow step with resolve-ticket.py (see
pipeline_lib.py) and writes to the same .gap-plan.md file resolve-ticket
reads on startup - so if this script reports remaining criteria, running
`resolve-ticket <ticket-id>` immediately afterward re-enters straight
into the per-criterion implementation loop instead of re-fetching the
ticket, re-planning, and re-narrowing from scratch.

Uses opencode zen (see ai_client.py) via the local tool layer (see
tools.py: read_file, list_dir, write_file - no MCP). The model can read
and write the workspace itself through these tools for anything not
already known.

Plan and narrow run as separate sessions with clean context windows, so
this script bridges them: things we know with certainty either step
needs (the ticket, the plan, the plan's own named implementation files)
are read host-side and embedded directly into the initial prompt -
removing the cost of the model rediscovering them from scratch and the
turn-budget risk of it not getting around to asking. The one thing
neither embedding nor tools can provide is command output (cargo test,
etc.) - that's gathered by pipeline_lib.py via a strict allowlist (see
ALLOWED_CARGO_SUBCOMMANDS) and handed to the narrower directly, since
run_command is intentionally refused as a model-callable tool (see
tools.py).

Usage:
    check-ticket <ticket-id> [--model <model-id>]

Options:
    --model             opencode zen model ID, e.g. deepseek-v4-flash-free.
                        Defaults to "claude-haiku-4-5" - chosen by benchmarking
                        several models across both the plan and narrow steps
                        (see pipeline_lib.py history); it was the only model
                        that reliably passed both.
"""

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import ai_client  # noqa: E402
import pipeline_lib as lib  # noqa: E402
import tools  # noqa: E402

DEFAULT_MODEL = "gpt-5.4-mini"


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Fetch a Linear ticket, plan it with TDD, and narrow the plan to the current gap.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument("ticket_id", help="Linear ticket ID, e.g. NEB-42")
    parser.add_argument(
        "--model",
        default=DEFAULT_MODEL,
        help=f"opencode zen model ID to use (default: {DEFAULT_MODEL}).",
    )
    args = parser.parse_args()
    model = args.model

    # ── Step 0: Clean slate ─────────────────────────────────────────────────
    lib.clean_stale_state()

    # ── Step 1: Fetch ticket ────────────────────────────────────────────────
    ticket_content = lib.fetch_ticket_text(args.ticket_id)
    tools.write_file_block(str(lib.TICKET_FILE))(ticket_content)

    # ── Step 2: Plan (ticket embedded in prompt; plan text returned) ──────
    plan_content = lib.run_plan_step(ticket_content, model)

    # ── Step 3: Narrow (model reads via tools; commands run by us) ────────
    gap_plan_content = lib.run_narrow_step(ticket_content, plan_content, model)

    remaining = lib.extract_acceptance_criteria(gap_plan_content)
    if remaining:
        print(
            f"\n-- {len(remaining)} acceptance criterion(criteria) still unsatisfied. "
            f"Run 'resolve-ticket {args.ticket_id}' to implement them.",
            flush=True,
        )
    else:
        print("\n-- All acceptance criteria satisfied. Ticket is complete.", flush=True)
    print(f"-- Token usage: {ai_client.usage}", flush=True)


if __name__ == "__main__":
    main()

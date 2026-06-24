#!/usr/bin/env python3
"""
check-ticket - Fetch a Linear ticket, run the plan prompt, then validate the TDD plan.

Always non-interactive: the planner self-clarifies any ambiguity from
ticket context rather than asking. Any failure (missing command, missing
file, non-zero exit/HTTP error from the backend) aborts immediately with
a reason on stderr - there is no fallback prompting.

Report-only: this script always renders the validator's verdict and
exits 0 regardless of what it says (APPROVED, REVISIONS REQUIRED, or
INCOMPLETE REVIEW) - it never branches on the verdict itself. For a
script that continues into a TDD implementation flow when the verdict is
REVISIONS REQUIRED, see resolve-ticket.py, which reuses this same
fetch/plan/validate sequence (see pipeline_lib.py) and adds that
continuation on top rather than duplicating it.

Uses opencode zen (see ai_client.py) via the local tool layer (see
tools.py: read_file, list_dir, write_file - no MCP). The model can read
and write the workspace itself through these tools for anything not
already known.

Plan and validate run as separate sessions with clean context windows,
so this script bridges them: things we know with certainty either step
needs (the ticket, the plan, the plan's own named implementation files)
are read host-side and embedded directly into the initial prompt -
removing the cost of the model rediscovering them from scratch and the
turn-budget risk of it not getting around to asking. The one thing
neither embedding nor tools can provide is command output (cargo test,
etc.) - that's gathered by pipeline_lib.py via a strict allowlist (see
ALLOWED_CARGO_SUBCOMMANDS) and handed to the validator directly, since
run_command is intentionally refused as a model-callable tool (see
tools.py).

Usage:
    check-ticket <ticket-id> [--model <model-id>]

Options:
    --model             opencode zen model ID, e.g. deepseek-v4-flash-free.
                        Defaults to "default".
"""

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import ai_client  # noqa: E402
from ai_client import DEFAULT_MODEL  # noqa: E402
import pipeline_lib as lib  # noqa: E402
from render import render_markdown  # noqa: E402
import tools  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Fetch a Linear ticket, plan it with TDD, and validate the plan.",
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

    # ── Step 3: Validate (model reads via tools; commands run by us) ──────
    result = lib.run_validate_step(ticket_content, plan_content, model)

    render_markdown(result.text)
    print(f"\n-- Done. Token usage: {ai_client.usage}", flush=True)


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""
bench_block - run exactly one pipeline_lib block once, against fixed
fixture inputs, and report machine-readable pass/fail/cost/duration.

Always invoked as a subprocess by bench.py, with cwd already set to an
isolated git worktree (so this script's own relative-path tool reads -
libs/virtual_assistant_api/... - resolve against a real checkout, and
concurrent trials never collide on .ticket.md/.tdd-plan.md/.gap-plan.md
since each worktree is its own directory).

Deliberately does not import check-ticket.py/resolve-ticket.py - those
chain blocks together (plan's real output feeds narrow). Benchmarking a
single block in isolation means feeding it a fixed fixture instead of a
live upstream result, which is the whole point: it separates "is this
model good at narrow" from "did the model before it hand narrow a good
or bad plan".

Grading is a hardcoded heuristic per (ticket, block) pair - good enough
to bulk-run many trials and get a pass-rate signal, but it's pattern
matching on the plan text, not a real compiler/test check. Treat the
reason string as a hint to spot-check, not ground truth.

Prints exactly one line of JSON to stdout:
  {"success": bool, "reason": str, "duration_s": float,
   "cost_usd": float, "tokens_total": int, "error": str|null}
"""

import argparse
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import ai_client  # noqa: E402
import pipeline_lib as lib  # noqa: E402


def grade_sa452_no_file_split(plan_text: str) -> tuple[bool, str]:
    """
    SA-452's known failure mode: a flash/budget-tier model takes the
    ticket's literal "create xero_webhook_config.rs" wording at face
    value instead of noticing the codebase already implements both
    structs in infra/accounting_webhooks.rs (alongside the sibling
    QuickbooksWebhookConfig). PASS means the plan/gap-plan keeps the fix
    anchored in the existing file; FAIL means it proposes splitting into
    new per-struct files.
    """
    lowered = plan_text.lower()
    proposes_new_file = (
        "xero_webhook_config.rs" in lowered or "quickbooks_webhook_config.rs" in lowered
    )
    mentions_existing_file = "accounting_webhooks.rs" in lowered
    if proposes_new_file:
        return False, "plan proposes new xero_webhook_config.rs/quickbooks_webhook_config.rs files"
    if not mentions_existing_file:
        return False, "plan never references the existing accounting_webhooks.rs"
    return True, "plan anchors the fix in the existing accounting_webhooks.rs"


GRADERS = {
    ("sa452", "plan"): grade_sa452_no_file_split,
    ("sa452", "narrow"): grade_sa452_no_file_split,
}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--block", required=True, choices=["plan", "narrow"])
    parser.add_argument("--ticket-name", required=True, help="Grader key, e.g. sa452")
    parser.add_argument("--ticket-file", required=True, type=Path)
    parser.add_argument("--plan-file", type=Path, help="Required for --block narrow")
    parser.add_argument("--model", required=True)
    args = parser.parse_args()

    grader = GRADERS.get((args.ticket_name, args.block))
    if grader is None:
        print(json.dumps({"error": f"no grader for ({args.ticket_name}, {args.block})"}))
        sys.exit(1)

    ticket_content = args.ticket_file.read_text(encoding="utf-8")

    start = time.monotonic()
    error = None
    output_text = ""
    try:
        if args.block == "plan":
            output_text = lib.run_plan_step(ticket_content, args.model)
        else:
            if not args.plan_file:
                raise ValueError("--plan-file is required for --block narrow")
            plan_content = args.plan_file.read_text(encoding="utf-8")
            output_text = lib.run_narrow_step(ticket_content, plan_content, args.model)
    except SystemExit as e:
        error = f"block aborted (exit {e.code}) - see die() output above"
    except Exception as e:  # noqa: BLE001 - report any failure as a graded trial, not a crash
        error = f"{type(e).__name__}: {e}"
    duration_s = time.monotonic() - start

    cost_usd, unpriced = ai_client.usage.total_cost_usd()
    result = {
        "duration_s": round(duration_s, 2),
        "cost_usd": round(cost_usd, 4),
        "tokens_total": ai_client.usage.total_tokens,
        "unpriced_models": unpriced,
        "error": error,
    }
    if error:
        result["success"] = False
        result["reason"] = error
    else:
        success, reason = grader(output_text)
        result["success"] = success
        result["reason"] = reason

    # pipeline_lib's own run_*_step calls print progress lines (and
    # render_markdown output) to stdout throughout the run - this marker
    # lets bench.py find our result line without needing to silence them.
    print("===BENCH_RESULT===")
    print(json.dumps(result))


if __name__ == "__main__":
    main()

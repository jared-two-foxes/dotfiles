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

Grading for plan/narrow is a hardcoded text heuristic per (ticket,
block) pair - good enough to bulk-run many trials and get a pass-rate
signal, but it's pattern matching on the plan text, not a real
compiler/test check. Treat the reason string as a hint to spot-check,
not ground truth.

Grading for test-criterion is a real check, not a heuristic: it
compiles the test the model wrote (cargo test --no-run) and then runs
it scoped (cargo test {filter}), requiring it to fail (red) - a
criterion that isn't implemented yet should produce a failing test, not
a compile error and not an accidental pass. This is slower (real cargo
invocations) but answers the actual question instead of guessing from
text.

Grading for implement-criterion is the mirror of test-criterion: the
worktree is seeded with a known-good failing test (a fixture captured
from a real test-criterion trial - see fixtures/<ticket>/*.meta.json),
the model implements against it, and the check is the same compile step
followed by the same scoped run - but this time requiring it to pass
(green). The test file is passed to run_implement_for_criterion as a
protected path, same as the real pipeline.

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


def grade_test_criterion_compiles_and_red(file_path: str, qualified_test_name: str) -> tuple[bool, str]:
    """
    Real correctness check (not a text heuristic) for any ticket: the
    test the model wrote must (a) compile as part of the whole test
    binary, and (b) fail when run scoped to just that test - the
    criterion it covers isn't implemented yet in the fixture's gap plan,
    so a correct test must be red. A test that doesn't compile is a
    Tester bug; a test that passes green means it didn't actually
    exercise the missing behavior (the gap "didn't reproduce").
    """
    commands = lib.load_pipeline_config(Path(lib.PIPELINE_CONFIG_FILE))

    compile_result = lib.run_command(commands["test_compile_cmd"], "bench test compile gate")
    if compile_result.returncode != 0:
        tail = (compile_result.stdout + compile_result.stderr)[-1500:]
        return False, f"test does not compile (exit {compile_result.returncode}): {tail}"

    red_result = lib.run_scoped_test(qualified_test_name, commands, "bench red check")
    if red_result.returncode == 0:
        return False, "test passed without implementation - gap didn't reproduce (false green)"

    return True, f"test ({file_path}::{qualified_test_name}) compiles and correctly fails red"


def grade_implement_compiles_and_green(qualified_test_name: str) -> tuple[bool, str]:
    """
    Real correctness check for implement-criterion: the implementation
    must (a) compile, and (b) make the seeded test pass when run scoped
    to just that test. A compile failure is an Implementer bug; a still-
    failing scoped test means the implementation didn't actually satisfy
    the criterion the test exercises.
    """
    commands = lib.load_pipeline_config(Path(lib.PIPELINE_CONFIG_FILE))

    build_result = lib.run_command(commands["build_cmd"], "bench build gate")
    if build_result.returncode != 0:
        tail = (build_result.stdout + build_result.stderr)[-1500:]
        return False, f"implementation does not compile (exit {build_result.returncode}): {tail}"

    green_result = lib.run_scoped_test(qualified_test_name, commands, "bench green check")
    if green_result.returncode != 0:
        tail = (green_result.stdout + green_result.stderr)[-1500:]
        return False, f"test still fails after implementation (exit {green_result.returncode}): {tail}"

    return True, f"implementation compiles and {qualified_test_name} passes green"


GRADERS = {
    ("sa452", "plan"): grade_sa452_no_file_split,
    ("sa452", "narrow"): grade_sa452_no_file_split,
}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--block", required=True,
        choices=["plan", "narrow", "test-criterion", "implement-criterion"],
    )
    parser.add_argument("--ticket-name", required=True, help="Grader key, e.g. sa452")
    parser.add_argument("--ticket-file", required=True, type=Path)
    parser.add_argument(
        "--plan-file", type=Path,
        help="Required for --block narrow/test-criterion/implement-criterion",
    )
    parser.add_argument("--criterion", help="Required for --block test-criterion/implement-criterion")
    parser.add_argument(
        "--test-file",
        help="Required for --block implement-criterion - path to the seeded failing test, "
             "passed through as run_implement_for_criterion's protected path",
    )
    parser.add_argument(
        "--qualified-test-name",
        help="Required for --block implement-criterion - the scoped test name to green-check",
    )
    parser.add_argument("--model", required=True)
    args = parser.parse_args()

    if args.block in ("plan", "narrow"):
        grader = GRADERS.get((args.ticket_name, args.block))
        if grader is None:
            print(json.dumps({"error": f"no grader for ({args.ticket_name}, {args.block})"}))
            sys.exit(1)

    ticket_content = args.ticket_file.read_text(encoding="utf-8")

    start = time.monotonic()
    error = None
    success = False
    reason = ""
    try:
        if args.block == "plan":
            output_text = lib.run_plan_step(ticket_content, args.model)
            success, reason = grader(output_text)
        elif args.block == "narrow":
            if not args.plan_file:
                raise ValueError("--plan-file is required for --block narrow")
            plan_content = args.plan_file.read_text(encoding="utf-8")
            output_text = lib.run_narrow_step(ticket_content, plan_content, args.model)
            success, reason = grader(output_text)
        elif args.block == "test-criterion":
            if not args.plan_file:
                raise ValueError("--plan-file (the gap plan) is required for --block test-criterion")
            if not args.criterion:
                raise ValueError("--criterion is required for --block test-criterion")
            plan_content = args.plan_file.read_text(encoding="utf-8")
            file_path, qualified_test_name = lib.run_test_for_criterion(
                args.criterion, plan_content, args.model
            )
            success, reason = grade_test_criterion_compiles_and_red(file_path, qualified_test_name)
        else:  # implement-criterion
            missing = [
                name for name, val in (
                    ("--plan-file", args.plan_file), ("--criterion", args.criterion),
                    ("--test-file", args.test_file), ("--qualified-test-name", args.qualified_test_name),
                ) if not val
            ]
            if missing:
                raise ValueError(f"--block implement-criterion requires {', '.join(missing)}")
            plan_content = args.plan_file.read_text(encoding="utf-8")
            lib.run_implement_for_criterion(
                args.criterion, plan_content, args.model, args.test_file
            )
            success, reason = grade_implement_compiles_and_green(args.qualified_test_name)
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
        result["success"] = success
        result["reason"] = reason

    # pipeline_lib's own run_*_step calls print progress lines (and
    # render_markdown output) to stdout throughout the run - this marker
    # lets bench.py find our result line without needing to silence them.
    print("===BENCH_RESULT===")
    print(json.dumps(result))


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""
bench - run a pipeline_lib block (plan, narrow) N times per model,
concurrently, each trial isolated in its own git worktree, and report a
pass-rate/cost/duration table per model.

Why worktrees: pipeline_lib writes fixed-name state files (.ticket.md,
.tdd-plan.md, .gap-plan.md) into the cwd, and the model's own file-read
tool calls resolve paths relative to cwd too. Two trials sharing a cwd
would clobber each other's state and could even read each other's
half-written files mid-run. A git worktree gives each trial its own
real checkout of the target repo - concurrent trials are then exactly
as safe as two people working in two separate clones, which is also
the same mechanism you'd want for running unrelated tickets in parallel
in real (non-benchmark) use.

Why fixtures instead of chaining live steps: testing "narrow" in
isolation should measure narrow's own competence, not whatever plan
happened to come before it. Each trial gets a fixed ticket fixture and
(for narrow) a fixed plan fixture - either the known-good plan or the
known-bad (file-split) plan - so you get two independent answers: does
this model narrow correctly from a clean plan, and does it catch/fix a
bad one.

Usage:
    bench.py --block plan --models deepseek-v4-pro,glm-5 --trials 3
    bench.py --block narrow --models glm-5,gpt-5.1 --trials 3 --plan-fixture both

Each trial calls bench_block.py as a subprocess with cwd set to its
worktree - see that file for the actual block invocation + grading.
"""

import argparse
import json
import statistics
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from pathlib import Path

# `git worktree add`/`remove` race against each other when run
# concurrently on the same repo (git's own .git/worktrees bookkeeping
# isn't safe for parallel invocations) - serialize just these two calls.
# The worktrees themselves still run fully in parallel once created.
_WORKTREE_LOCK = threading.Lock()

SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_REPO = Path.home() / "code" / "own" / "VirtualAssistant"


@dataclass
class Job:
    model: str
    block: str
    ticket_name: str
    ticket_file: Path
    plan_fixture: str | None  # "good" / "bad" / None (plan block has no upstream plan)
    plan_file: Path | None
    trial_index: int


@dataclass
class TrialResult:
    job: Job
    success: bool = False
    reason: str = ""
    duration_s: float = 0.0
    cost_usd: float = 0.0
    tokens_total: int = 0
    worktree_setup_s: float = 0.0
    crash: str | None = None


def create_worktree(repo: Path, base_ref: str) -> Path:
    wt_path = Path(tempfile.gettempdir()) / "bench-worktrees" / uuid.uuid4().hex[:12]
    with _WORKTREE_LOCK:
        subprocess.run(
            ["git", "-C", str(repo), "worktree", "add", "--detach", str(wt_path), base_ref],
            check=True,
            capture_output=True,
            text=True,
        )
    return wt_path


def remove_worktree(repo: Path, wt_path: Path) -> None:
    with _WORKTREE_LOCK:
        subprocess.run(
            ["git", "-C", str(repo), "worktree", "remove", "--force", str(wt_path)],
            check=False,
            capture_output=True,
            text=True,
        )


def parse_bench_result(stdout: str) -> dict:
    marker = "===BENCH_RESULT==="
    if marker not in stdout:
        raise ValueError(f"no result marker in subprocess output:\n{stdout[-2000:]}")
    json_line = stdout.rsplit(marker, 1)[1].strip().splitlines()[0]
    return json.loads(json_line)


def run_trial(job: Job, repo: Path, base_ref: str) -> TrialResult:
    result = TrialResult(job=job)
    setup_start = time.monotonic()
    try:
        wt_path = create_worktree(repo, base_ref)
    except subprocess.CalledProcessError as e:
        result.crash = f"worktree setup failed: {e.stderr}"
        return result
    result.worktree_setup_s = round(time.monotonic() - setup_start, 2)

    try:
        cmd = [
            sys.executable,
            str(SCRIPT_DIR / "bench_block.py"),
            "--block", job.block,
            "--ticket-name", job.ticket_name,
            "--ticket-file", str(job.ticket_file),
            "--model", job.model,
        ]
        if job.plan_file:
            cmd += ["--plan-file", str(job.plan_file)]

        proc = subprocess.run(
            cmd, cwd=str(wt_path), capture_output=True, text=True, timeout=900,
            encoding="utf-8", errors="replace",
        )
        if proc.returncode != 0 and "===BENCH_RESULT===" not in proc.stdout:
            result.crash = (
                f"subprocess exit {proc.returncode}, no result line. "
                f"stderr tail: {proc.stderr[-1500:]}"
            )
            return result
        parsed = parse_bench_result(proc.stdout)
        result.success = parsed["success"]
        result.reason = parsed["reason"]
        result.duration_s = parsed["duration_s"]
        result.cost_usd = parsed["cost_usd"]
        result.tokens_total = parsed["tokens_total"]
    except subprocess.TimeoutExpired:
        result.crash = "trial timed out after 900s"
    except Exception as e:  # noqa: BLE001
        result.crash = f"{type(e).__name__}: {e}"
    finally:
        remove_worktree(repo, wt_path)

    return result


def build_jobs(args) -> list[Job]:
    fixtures_dir = Path(args.fixtures_dir)
    ticket_file = fixtures_dir / "ticket.md"
    if not ticket_file.is_file():
        raise SystemExit(f"missing ticket fixture: {ticket_file}")

    models = [m.strip() for m in args.models.split(",") if m.strip()]
    jobs: list[Job] = []

    if args.block == "plan":
        for model in models:
            for trial in range(args.trials):
                jobs.append(Job(
                    model=model, block="plan", ticket_name=args.ticket_name,
                    ticket_file=ticket_file, plan_fixture=None, plan_file=None,
                    trial_index=trial,
                ))
    else:  # narrow
        variants = ["good", "bad"] if args.plan_fixture == "both" else [args.plan_fixture]
        for variant in variants:
            plan_file = fixtures_dir / f"plan-{variant}.md"
            if not plan_file.is_file():
                raise SystemExit(f"missing plan fixture: {plan_file}")
            for model in models:
                for trial in range(args.trials):
                    jobs.append(Job(
                        model=model, block="narrow", ticket_name=args.ticket_name,
                        ticket_file=ticket_file, plan_fixture=variant, plan_file=plan_file,
                        trial_index=trial,
                    ))
    return jobs


def print_summary(results: list[TrialResult]) -> None:
    groups: dict[tuple[str, str | None], list[TrialResult]] = {}
    for r in results:
        key = (r.job.model, r.job.plan_fixture)
        groups.setdefault(key, []).append(r)

    header = f"{'model':<20} {'fixture':<8} {'trials':<7} {'pass':<6} {'avg_s':<8} {'avg_$':<8} {'total_$':<8}"
    print(header)
    print("-" * len(header))
    for (model, fixture), group in sorted(groups.items()):
        n = len(group)
        ok = [r for r in group if r.crash is None]
        passed = sum(1 for r in ok if r.success)
        crashed = n - len(ok)
        avg_s = statistics.mean(r.duration_s for r in ok) if ok else 0.0
        avg_cost = statistics.mean(r.cost_usd for r in ok) if ok else 0.0
        total_cost = sum(r.cost_usd for r in ok)
        fixture_label = fixture or "-"
        crash_note = f" ({crashed} crashed)" if crashed else ""
        print(
            f"{model:<20} {fixture_label:<8} {n:<7} {passed}/{len(ok)}{crash_note:<6} "
            f"{avg_s:<8.1f} {avg_cost:<8.4f} {total_cost:<8.4f}"
        )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--block", required=True, choices=["plan", "narrow"])
    parser.add_argument("--models", required=True, help="Comma-separated model IDs")
    parser.add_argument("--trials", type=int, default=3)
    parser.add_argument("--concurrency", type=int, default=4)
    parser.add_argument("--repo", type=Path, default=DEFAULT_REPO)
    parser.add_argument("--base-ref", default="HEAD")
    parser.add_argument("--ticket-name", default="sa452")
    parser.add_argument("--fixtures-dir", default=str(SCRIPT_DIR / "fixtures" / "sa452"))
    parser.add_argument("--plan-fixture", default="both", choices=["good", "bad", "both"],
                         help="Only used for --block narrow")
    parser.add_argument("--out", default=None, help="Path to write results.jsonl (default: bench-<block>-<timestamp>.jsonl)")
    args = parser.parse_args()

    out_path = Path(args.out) if args.out else Path(f"bench-{args.block}-{int(time.time())}.jsonl")

    jobs = build_jobs(args)
    print(f"-- Running {len(jobs)} trials across {args.concurrency} workers ...", flush=True)

    results: list[TrialResult] = []
    with ThreadPoolExecutor(max_workers=args.concurrency) as pool, out_path.open("w", encoding="utf-8") as out_f:
        futures = {pool.submit(run_trial, job, args.repo, args.base_ref): job for job in jobs}
        for future in as_completed(futures):
            job = futures[future]
            r = future.result()
            results.append(r)
            status = "CRASH" if r.crash else ("PASS" if r.success else "FAIL")
            print(
                f"   [{status}] model={job.model} block={job.block} "
                f"fixture={job.plan_fixture or '-'} trial={job.trial_index} "
                f"{r.duration_s:.1f}s ${r.cost_usd:.4f} - {r.crash or r.reason}",
                flush=True,
            )
            out_f.write(json.dumps({
                "model": job.model, "block": job.block, "fixture": job.plan_fixture,
                "trial": job.trial_index, "success": r.success, "reason": r.reason,
                "duration_s": r.duration_s, "cost_usd": r.cost_usd,
                "tokens_total": r.tokens_total, "crash": r.crash,
            }) + "\n")
            out_f.flush()

    print(f"\n-- Results written to {out_path}\n", flush=True)
    print_summary(results)


if __name__ == "__main__":
    main()

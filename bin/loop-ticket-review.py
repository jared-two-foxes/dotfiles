#!/usr/bin/env python3
"""
loop-ticket-review - drive review-ticket.py / propose-ticket-edit.py back
and forth until a review comes back clean or a round threshold is hit.

This is the manual loop documented in review-ticket.py's own docstring,
automated: each round runs review-ticket.py (against the working file
from the previous round, once one exists), reads the verdict out of the
.ticket-review-{ticket-id}.md file it saves, and stops if that verdict
is "clear". Otherwise it runs propose-ticket-edit.py against the same
working file and tries again next round.

Never touches Linear and never touches .ticket.md - --ticket-file is the
one working file passed between rounds (explicit, no implicit naming
convention - default .ticket-proposed-{ticket-id}.md, same as you'd pick
by hand). Stops early if propose-ticket-edit.py produces no revision
(its "no remaining work" case) - there's nothing left to loop on.

Usage:
    loop-ticket-review.py <ticket-id> [--model <model-id>]
                           [--max-iterations <n>] [--ticket-file <path>]
"""

import argparse
import re
import subprocess
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
VERDICT_RE = re.compile(r"^###\s*Verdict\s*\n+(\S+)", re.MULTILINE)
NO_REVISION_MARKER = "no-remaining-work case"


def review_file_path(ticket_id: str) -> Path:
    return Path(f".ticket-review-{ticket_id}.md")


def run_review(ticket_id: str, model: str, ticket_file_in: Path | None) -> None:
    cmd = [sys.executable, str(SCRIPT_DIR / "review-ticket.py"), ticket_id, "--model", model]
    if ticket_file_in is not None:
        cmd += ["--ticket-file-in", str(ticket_file_in)]
    print(f"-- running: {' '.join(cmd)}")
    result = subprocess.run(cmd)
    if result.returncode != 0:
        print(f"\n>>> FAILED: review-ticket.py failed (exit {result.returncode}).")
        sys.exit(1)


def run_propose(ticket_id: str, model: str, ticket_file_out: Path) -> bool:
    """Returns True if a revision was written, False for the no-remaining-work case."""
    cmd = [
        sys.executable, str(SCRIPT_DIR / "propose-ticket-edit.py"), ticket_id,
        "--model", model, "--ticket-file-out", str(ticket_file_out),
    ]
    print(f"-- running: {' '.join(cmd)}")
    result = subprocess.run(cmd, capture_output=True, text=True)
    print(result.stdout)
    if result.returncode != 0:
        print(result.stderr, file=sys.stderr)
        print(f"\n>>> FAILED: propose-ticket-edit.py failed (exit {result.returncode}).")
        sys.exit(1)
    return NO_REVISION_MARKER not in result.stdout


def read_verdict(ticket_id: str) -> str:
    path = review_file_path(ticket_id)
    text = path.read_text(encoding="utf-8")
    match = VERDICT_RE.search(text)
    if not match:
        print(f"\n>>> FAILED: could not find a '### Verdict' line in {path}.")
        sys.exit(1)
    return match.group(1).strip().lower()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("ticket_id", help="Linear ticket ID, e.g. NEB-42")
    parser.add_argument("--model", default="opencode:gpt-5.4-mini")
    parser.add_argument(
        "--max-iterations", type=int, default=5,
        help="Stop after this many review/propose rounds without a clean review (default: 5).",
    )
    parser.add_argument(
        "--ticket-file", type=Path, default=None,
        help="Working file passed between rounds (default: .ticket-proposed-{ticket-id}.md).",
    )
    args = parser.parse_args()

    work_file = args.ticket_file or Path(f".ticket-proposed-{args.ticket_id}.md")

    for i in range(1, args.max_iterations + 1):
        print(f"\n=== Round {i}/{args.max_iterations} ===")

        run_review(args.ticket_id, args.model, work_file if work_file.exists() else None)

        verdict = read_verdict(args.ticket_id)
        print(f"-- verdict: {verdict}")
        if verdict == "clear":
            print(f"\n-- Clean after {i} round(s). Working ticket: {work_file if work_file.exists() else '(unchanged original)'}")
            print(f"\n>>> SUCCESS: review-ticket reported a clean verdict after {i} round(s).")
            return

        if not run_propose(args.ticket_id, args.model, work_file):
            print("\n-- propose-ticket-edit.py produced no revision (no remaining work) - nothing left to loop on.")
            print(f"\n>>> FAILED: stopped after round {i} with unresolved concerns and no revision to try - see {review_file_path(args.ticket_id)}.")
            sys.exit(1)

    print(f"\n-- Hit --max-iterations ({args.max_iterations}) without a clean review. Last working file: {work_file}")
    print(f"\n>>> FAILED: did not reach a clean review within {args.max_iterations} round(s) - see {review_file_path(args.ticket_id)}.")
    sys.exit(1)


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""
prep-ticket - automate everything that can be automated before a ticket
reaches the genuinely-interactive part of the workflow (explore-ticket),
then stop and hand off.

Two phases, both non-interactive (no AI call here ever needs a human):

  1. Review <-> propose loop (this is what loop-ticket-review.py used to
     be, on its own): drive review-ticket.py / propose-ticket-edit.py
     back and forth until a review comes back clean or --max-iterations
     is hit. Each round runs review-ticket.py (against the working file
     from the previous round, once one exists), reads the verdict out of
     the .ticket-review-{ticket-id}.md file it saves, and stops if that
     verdict is "clear". Otherwise it runs propose-ticket-edit.py against
     the same working file and tries again next round.

  2. Complexity check: once the review is clean, runs split-ticket.py
     against the (possibly revised) working file, passing along the
     phase-1 review report as grounding context (--review-file-in - see
     split-ticket.py's own docstring for exactly what that does and
     doesn't change), and reads its verdict out of
     .ticket-split-{ticket-id}.md. A "no-split" verdict means the ticket
     is ready for explore-ticket. Anything else runs create-child-
     tickets.py --yes by default to turn the proposed children into real
     Linear sub-issues of the parent, then pushes each one onto the
     criteria stack ahead of the parent via `push_ticket --prepend`, in
     order, plus a `--validate-only` sentinel for the parent itself
     underneath all of them - see the dry-run handling in main() for
     exactly how that ordering works and why. Pass --dry-run to only
     preview the proposed children instead - nothing is created or
     pushed in that case.

Why these two phases specifically, and not further (e.g. all the way
through explore-ticket): explore-ticket is a real, interactive
conversation - the model asks you questions and needs a real answer.
There is no way to automate past that point, so this script doesn't try;
it hands off with a printed next-step command instead. Running
split-ticket AFTER the review loop but BEFORE explore-ticket is
deliberate too: explore-ticket's whole job is splitting vague acceptance
criteria into more, independently-testable ones, which inflates the
criteria count that split-ticket's mechanical pre-check partly keys off
- assessed in the other order, a ticket that never actually grew in
scope could still trip a false "this needs splitting" signal purely from
having been phrased more precisely.

Never touches .ticket.md - --ticket-file-out is the one working file
passed between review/propose rounds (explicit, no implicit naming
convention - default .ticket-proposed-{ticket-id}.md, same as you'd pick
by hand; same flag name propose-ticket-edit.py itself uses for the same
file). Does touch Linear on a split recommendation, by default - creating
the child sub-issues is the one real mutation this script can trigger.
Unlike update-ticket.py's own --yes-gated mutation (a single ticket's
title/description, easy to eyeball before committing), this one defaults
to proceeding automatically: pass --dry-run if you want to preview the
proposed children before anything is created.

Exit codes distinguish three outcomes, not two - "stopped" is not always
"failed":
  0 - either phase reached a real conclusion: a clean review that's also
      right-sized (explore-ticket next), a split recommendation handled
      (children created in Linear and pushed onto the stack ahead of the
      parent, or with --dry-run, just a preview), or propose-ticket-
      edit's "no remaining work" case - which in practice means every
      acceptance criterion turned out to already be satisfied by
      existing code, so there's nothing to prep at all (consider closing
      the ticket instead). All of these are successful, actionable
      outcomes.
  1 - a genuine pipeline failure: a subprocess errored, the review loop
      hit --max-iterations without ever reaching a clean verdict, or a
      split was created but nothing ended up in .ticket-children-
      {ticket-id}.json to push.

Usage:
    prep-ticket <ticket-id> [--model <model-id>] [--max-iterations <n>]
                [--ticket-file-out <path>] [--split-threshold <n>]
                [--force-split-ai] [--dry-run]
"""

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

# Every subprocess.run() below passes text=True with no explicit encoding
# unless one is given - and each one *is* given encoding="utf-8",
# errors="replace" - because the child scripts (review_ticket.py etc.)
# write UTF-8 via render.py's own TextIOWrapper, but subprocess.run's
# default text-mode decoding falls back to locale.getpreferredencoding()
# (cp1252 on this machine), which doesn't cover every UTF-8 byte
# sequence - e.g. a stray 0x9D from a multi-byte character is outright
# undefined in cp1252. Without the explicit encoding, that decode fails
# inside subprocess.run's internal reader thread, silently leaving
# result.stdout as None rather than raising where it'd be caught. Same
# fix bench.py's own bench_block subprocess call already needed for
# identical reasons. Reconfiguring this script's own stdout/stderr below
# guards the symmetric case - printing decoded child output back out
# through this process's own (possibly non-UTF-8) console.
sys.stdout.reconfigure(errors="replace")
sys.stderr.reconfigure(errors="replace")

VERDICT_RE = re.compile(r"^###\s*Verdict\s*\n+(\S+)", re.MULTILINE)
NO_REVISION_MARKER = "no-remaining-work case"

# Matches the "-- Token usage: N tokens total (P in / C out)[, ~$X[+] (no
# pricing for: ...)]" line every review-ticket.py/propose-ticket-edit.py/
# split-ticket.py run prints (see ai_client.UsageTracker.__str__) - parsed
# back out of each subprocess's captured stdout so the rounds' costs can
# be summed, since each subprocess is its own process with its own
# UsageTracker instance and there's no other channel between them.
USAGE_RE = re.compile(
    r"Token usage:\s*([\d,]+) tokens total \(([\d,]+) in / ([\d,]+) out\)"
    r"(?:,\s*~\$([\d.]+))?"
)


def review_file_path(ticket_id: str) -> Path:
    return Path(f".ticket-review-{ticket_id}.md")


def split_file_path(ticket_id: str) -> Path:
    return Path(f".ticket-split-{ticket_id}.md")


def children_file_path(ticket_id: str) -> Path:
    return Path(f".ticket-children-{ticket_id}.json")


class CostTotal:
    """Accumulates token/cost figures parsed out of each round's subprocess
    output. `cost_is_lower_bound` goes True the first time a round's usage
    line has no $-figure at all, or carries the UsageTracker "+" suffix for
    an unpriced model - either way the running total stops being exact."""

    def __init__(self) -> None:
        self.prompt_tokens = 0
        self.completion_tokens = 0
        self.cost_usd = 0.0
        self.cost_is_lower_bound = False
        self.saw_any = False

    def add(self, stdout: str) -> None:
        match = USAGE_RE.search(stdout)
        if not match:
            return
        self.saw_any = True
        self.prompt_tokens += int(match.group(2).replace(",", ""))
        self.completion_tokens += int(match.group(3).replace(",", ""))
        if match.group(4) is not None:
            self.cost_usd += float(match.group(4))
            if "+" in stdout[match.end(4):match.end(4) + 1]:
                self.cost_is_lower_bound = True
        else:
            self.cost_is_lower_bound = True

    def __str__(self) -> str:
        if not self.saw_any:
            return "cost unknown (no token-usage lines found in subprocess output)"
        total = self.prompt_tokens + self.completion_tokens
        base = f"{total} tokens total ({self.prompt_tokens} in / {self.completion_tokens} out)"
        suffix = "+" if self.cost_is_lower_bound else ""
        return f"{base}, ~${self.cost_usd:.4f}{suffix}"


# Invoked via `-m`, not a file path, since review_ticket.py/
# propose_ticket_edit.py/split_ticket.py use package-relative imports now -
# running them by file path would fail with no parent package to resolve
# `from .lib import ...` against. `-m` works from any cwd once
# ticket_pipeline is installed (editable or otherwise), same as the old
# absolute-file-path approach did before the package conversion.
def run_review(ticket_id: str, model: str, ticket_file_in: Path | None, cost: CostTotal) -> None:
    cmd = [sys.executable, "-m", "ticket_pipeline.review_ticket", ticket_id, "--model", model]
    if ticket_file_in is not None:
        cmd += ["--ticket-file-in", str(ticket_file_in)]
    print(f"-- running: {' '.join(cmd)}")
    result = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    print(result.stdout)
    cost.add(result.stdout)
    if result.returncode != 0:
        print(result.stderr, file=sys.stderr)
        print(f"\n-- Combined token usage so far: {cost}")
        print(f"\n>>> FAILED: review-ticket.py failed (exit {result.returncode}).")
        sys.exit(1)


def run_propose(ticket_id: str, model: str, ticket_file_out: Path, cost: CostTotal) -> bool:
    """Returns True if a revision was written, False for the no-remaining-work case."""
    cmd = [
        sys.executable, "-m", "ticket_pipeline.propose_ticket_edit", ticket_id,
        "--model", model, "--ticket-file-out", str(ticket_file_out),
    ]
    print(f"-- running: {' '.join(cmd)}")
    result = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    print(result.stdout)
    cost.add(result.stdout)
    if result.returncode != 0:
        print(result.stderr, file=sys.stderr)
        print(f"\n-- Combined token usage so far: {cost}")
        print(f"\n>>> FAILED: propose-ticket-edit.py failed (exit {result.returncode}).")
        sys.exit(1)
    return NO_REVISION_MARKER not in result.stdout


def run_split(
    ticket_id: str,
    model: str,
    ticket_file_in: Path | None,
    threshold: int | None,
    force_ai: bool,
    cost: CostTotal,
) -> None:
    cmd = [sys.executable, "-m", "ticket_pipeline.split_ticket", ticket_id, "--model", model]
    if ticket_file_in is not None:
        cmd += ["--ticket-file-in", str(ticket_file_in)]
    if threshold is not None:
        cmd += ["--threshold", str(threshold)]
    if force_ai:
        cmd += ["--force-ai"]
    # Phase 1 always leaves a review report behind by the time phase 2
    # runs (either the original clean review, or the last loop round) -
    # feed it to split-ticket.py as grounding context (see its own
    # docstring for why this doesn't change which criteria go where).
    review_file = review_file_path(ticket_id)
    if review_file.exists():
        cmd += ["--review-file-in", str(review_file)]
    print(f"-- running: {' '.join(cmd)}")
    result = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    print(result.stdout)
    cost.add(result.stdout)
    if result.returncode != 0:
        print(result.stderr, file=sys.stderr)
        print(f"\n-- Combined token usage so far: {cost}")
        print(f"\n>>> FAILED: split-ticket.py failed (exit {result.returncode}).")
        sys.exit(1)


def run_create_children(ticket_id: str, split_file: Path, yes: bool, cost: CostTotal) -> None:
    """create_child_tickets.py is purely mechanical (no AI call), so
    cost.add() here is a harmless no-op - kept anyway so its stdout
    still flows through the same combined-usage accounting as every
    other step, in case that ever changes."""
    cmd = [
        sys.executable, "-m", "ticket_pipeline.create_child_tickets", ticket_id,
        "--split-file-in", str(split_file),
    ]
    if yes:
        cmd += ["--yes"]
    print(f"-- running: {' '.join(cmd)}")
    result = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    print(result.stdout)
    cost.add(result.stdout)
    if result.returncode != 0:
        print(result.stderr, file=sys.stderr)
        print(f"\n-- Combined token usage so far: {cost}")
        print(f"\n>>> FAILED: create-child-tickets.py failed (exit {result.returncode}).")
        sys.exit(1)


def run_push_prepend(ticket_id: str, cost: CostTotal, extra_args: list[str] | None = None) -> None:
    cmd = [sys.executable, "-m", "ticket_pipeline.push_ticket", ticket_id, "--prepend"]
    if extra_args:
        cmd += extra_args
    print(f"-- running: {' '.join(cmd)}")
    result = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    print(result.stdout)
    cost.add(result.stdout)
    if result.returncode != 0:
        print(result.stderr, file=sys.stderr)
        print(f"\n-- Combined token usage so far: {cost}")
        print(f"\n>>> FAILED: push_ticket --prepend for {ticket_id} failed (exit {result.returncode}).")
        sys.exit(1)


def read_verdict(path: Path, label: str) -> str:
    text = path.read_text(encoding="utf-8")
    match = VERDICT_RE.search(text)
    if not match:
        print(f"\n>>> FAILED: could not find a '### Verdict' line in {path} ({label}).")
        sys.exit(1)
    return match.group(1).strip().lower()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("ticket_id", help="Linear ticket ID, e.g. NEB-42")
    parser.add_argument("--model", default="opencode:gpt-5.4-mini")
    parser.add_argument(
        "--max-iterations", type=int, default=5,
        help="Stop the review/propose loop after this many rounds without a clean review (default: 5).",
    )
    parser.add_argument(
        "--ticket-file-out", type=Path, default=None,
        help="Working file passed between review/propose rounds, and into split-ticket "
             "afterward (default: .ticket-proposed-{ticket-id}.md).",
    )
    parser.add_argument(
        "--split-threshold", type=int, default=None,
        help="Passed through to split-ticket.py's --threshold. Default: split-ticket's own default.",
    )
    parser.add_argument(
        "--force-split-ai", action="store_true",
        help="Passed through to split-ticket.py's --force-ai (skip its mechanical pre-check).",
    )
    parser.add_argument(
        "--dry-run", action="store_true",
        help="If split-ticket recommends splitting: only preview the proposed child "
             "tickets - don't create them in Linear or push anything onto the stack. "
             "Without this, a split recommendation is acted on automatically "
             "(create-child-tickets.py --yes, then push_ticket --prepend for each child).",
    )
    args = parser.parse_args()

    work_file = args.ticket_file_out or Path(f".ticket-proposed-{args.ticket_id}.md")
    cost = CostTotal()

    # --- Phase 1: review <-> propose loop -----------------------------
    for i in range(1, args.max_iterations + 1):
        print(f"\n=== Review round {i}/{args.max_iterations} ===")

        run_review(args.ticket_id, args.model, work_file if work_file.exists() else None, cost)

        verdict = read_verdict(review_file_path(args.ticket_id), "review-ticket")
        print(f"-- verdict: {verdict}")
        if verdict == "clear":
            print(f"\n-- Clean after {i} round(s). Working ticket: {work_file if work_file.exists() else '(unchanged original)'}")
            break

        if not run_propose(args.ticket_id, args.model, work_file, cost):
            # Not a failure: propose-ticket-edit's own "no remaining work"
            # case fires specifically when resolving review-ticket's
            # concerns leaves nothing left to implement - in practice this
            # means every acceptance criterion turned out to already be
            # satisfied by existing code (see review-ticket.prompt.md's
            # Step 2 and propose-ticket-edit.prompt.md's Step 3). That's a
            # successful, actionable finding, not a broken run - exit 0,
            # and say so plainly rather than folding it into the generic
            # max-iterations/error failure path below.
            print(f"\n-- Combined token usage: {cost}")
            print(
                f"\n>>> ALREADY SATISFIED: resolving review-ticket's concerns for {args.ticket_id} "
                f"leaves no remaining work (see the 'No revision proposed' reasoning printed above, "
                f"and {review_file_path(args.ticket_id)}). This usually means the described "
                f"behavior already exists - consider closing {args.ticket_id} instead of "
                f"continuing to explore-ticket/push_ticket."
            )
            return
    else:
        print(f"\n-- Hit --max-iterations ({args.max_iterations}) without a clean review. Last working file: {work_file}")
        print(f"-- Combined token usage: {cost}")
        print(f"\n>>> FAILED: did not reach a clean review within {args.max_iterations} round(s) - see {review_file_path(args.ticket_id)}.")
        sys.exit(1)

    # --- Phase 2: complexity check -------------------------------------
    print("\n=== Complexity check ===")
    split_input = work_file if work_file.exists() else None
    run_split(args.ticket_id, args.model, split_input, args.split_threshold, args.force_split_ai, cost)

    split_verdict = read_verdict(split_file_path(args.ticket_id), "split-ticket")
    print(f"-- split verdict: {split_verdict}")
    print(f"\n-- Combined token usage: {cost}")

    next_ticket_ref = f"{args.ticket_id} --ticket-file-in {split_input}" if split_input else args.ticket_id
    if split_verdict == "no-split":
        print(f"\n>>> SUCCESS: {args.ticket_id} is reviewed and right-sized. Next: explore-ticket {next_ticket_ref}")
        return

    print(f"\n>>> SPLIT RECOMMENDED (verdict: {split_verdict}) - see {split_file_path(args.ticket_id)}.")

    run_create_children(args.ticket_id, split_file_path(args.ticket_id), not args.dry_run, cost)

    if args.dry_run:
        print(
            f"\n-- Dry run above - nothing was created. Re-run without --dry-run to create "
            f"these as Linear sub-issues of {args.ticket_id} and push them onto the stack "
            f"ahead of it, in order."
        )
        return

    children = json.loads(children_file_path(args.ticket_id).read_text(encoding="utf-8"))
    if not children:
        print(f"\n>>> FAILED: {children_file_path(args.ticket_id)} lists no children - nothing to push.")
        sys.exit(1)

    # The parent's own frame is a "validating" sentinel only, never real
    # criteria - split-ticket guarantees the children between them cover
    # every one of the parent's acceptance criteria, so there's nothing
    # left for the parent itself to implement. Pushed *first*: push_frames
    # prepends new frames ahead of whatever's already there, so pushing
    # the children *after*, in reverse, lands them ahead of this sentinel
    # in the final stack order (child 1 first, ..., child N last, then
    # this sentinel). Once the last child's frames pop, this sentinel is
    # what the parent finally validates against - a fresh re-narrow
    # against its *original* full scope, acting as the integration check
    # that the split actually covered everything (see next_step.py's
    # TICKET_VALIDATE step 4 self-heal for what happens if it didn't).
    run_push_prepend(args.ticket_id, cost, extra_args=["--validate-only"])
    for child in reversed(children):
        run_push_prepend(child["id"], cost)

    child_list = ", ".join(c["id"] for c in children)
    print(
        f"\n>>> SUCCESS: created and pushed {len(children)} child ticket(s) ahead of "
        f"{args.ticket_id}: {child_list}.\n"
        f"    Run next_step to begin working through them - {args.ticket_id} validates "
        f"automatically (a fresh check against its original full scope) once they're all done."
    )


if __name__ == "__main__":
    main()

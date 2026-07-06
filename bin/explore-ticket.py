#!/usr/bin/env python3
"""
explore-ticket - Interactive grill/explore/expand session that turns a
rough ticket into one with a complete set of acceptance criteria and
supporting context, before anyone plans or implements against it.

Deliberately standalone, same as review-ticket.py/propose-ticket-edit.py:
not called by push_ticket.py/next_step.py/pipeline_lib.py, and does not
write .ticket.md or any other pipeline state file. This is the one
genuinely interactive script in the set - every other prompt here is
single-shot and non-interactive (see tools.ASK_USER_PROMPT_SCHEMA, which
aborts the run the instant a model asks anything). This script is the
opposite on purpose: the model is expected to explore the codebase and
then actually converse with you at the terminal - asking one concrete
question at a time via ask_user_question, reading your real answer, and
using it to keep exploring or ask the next question - until it judges the
criteria/context complete enough to implement without further
back-and-forth.

Why this exists: review-ticket.py catches a ticket that's stale or
already-satisfied by checking it against the codebase; it never asks you
anything, because none of the scripts around it have a human available
mid-run. But plenty of ticket gaps aren't things the codebase can answer
- they're missing intent, unstated edge cases, or scope the author never
wrote down. This script is where that missing context gets pulled out of
you specifically, before the ticket goes anywhere near plan/narrow/
push_ticket.

Output is a proposed, expanded ticket - never written to Linear, never
written to .ticket.md unless you point --ticket-file-out at it yourself.
Feed it into the existing tools same as any other local revision, e.g.:

    explore-ticket SA-42 --ticket-file-out .ticket-explored-SA-42.md
    review-ticket SA-42 --ticket-file-in .ticket-explored-SA-42.md
    push_ticket SA-42 --ticket-file-in .ticket-explored-SA-42.md

--ticket-file-in is the same flag name every other script in this set
uses for "read the ticket from this local file instead of Linear".

Usage:
    explore-ticket <ticket-id> [--model <model-id>] [--ticket-file-in <path>]
                   (--ticket-file-out <path> | --no-write)
"""

import argparse
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "lib"))
import ai_client  # noqa: E402
import pipeline_lib as lib  # noqa: E402
import render  # noqa: E402
import tools  # noqa: E402
import verbosity  # noqa: E402

log = verbosity.get_logger(__name__)

DEFAULT_MODEL = "opencode:gpt-5.4-mini"

EXPLORE_PROMPT_FILE = lib.PROMPTS_DIR / "explore-ticket.prompt.md"

# Same dedup-key convention build_review_prompt uses - not a real
# on-disk path, just the key preloaded_paths seeds so a model that tries
# to read_file the ticket back after it was already embedded in the
# prompt gets the short "you already have this" note instead of a
# file-not-found error.
TICKET_DEDUP_KEY = ".ticket.md"

EXPANDED_TICKET_RE = re.compile(
    r"^## Expanded Ticket\s*\n(.*?)\n## What This Added\b",
    re.DOTALL | re.MULTILINE,
)


def default_output_path(ticket_id: str) -> Path:
    return Path(f".ticket-explored-{ticket_id}.md")


def build_explore_prompt(ticket_content: str, prefetch_block: str) -> str:
    instructions = lib.load_prompt_body(EXPLORE_PROMPT_FILE)
    prefetch_section = f"\n\n{prefetch_block}" if prefetch_block else ""
    return (
        f"{instructions}\n\n---\n\n"
        f"Here is the ticket - already complete and current, no need to "
        f"read_file it again:\n\n{ticket_content}{prefetch_section}\n\n"
        f"Explore the codebase with read_file/list_dir/search_files and "
        f"ask the human clarifying questions with ask_user_question - one "
        f"at a time, waiting for each real answer - until you have enough "
        f"to expand the ticket's acceptance criteria and context. Produce "
        f"the result in the exact format from Step 5 above. Your final "
        f"response (no further tool calls) must be exactly that output - "
        f"no chat header, no preamble or trailing commentary."
    )


def run_explore_step(ticket_content: str, model: str) -> str:
    prefetch_block, prefetch_paths = lib.prefetch_referenced_files(ticket_content)
    try:
        result = lib.run_ai_step_with_retry(
            lambda: ai_client.run_with_tools(
                build_explore_prompt(ticket_content, prefetch_block),
                tools.EXPLORE_TOOLS,
                tools.make_executor(
                    allow_write=False,
                    interactive=True,
                    preloaded_paths={TICKET_DEDUP_KEY} | prefetch_paths,
                ),
                "explore-ticket",
                model=model,
                summarize_call=tools.summarize_tool_call,
            ),
            "explore-ticket",
        )
    except (ai_client.AIError, tools.PipelineAbort) as e:
        lib.die(str(e))
    if "## Expanded Ticket" not in result.text:
        lib.render_step_output(result.text, level=0)
        lib.die("Explorer did not produce a valid expanded ticket (see output above).")
    return result.text


def extract_expanded_ticket(proposal_text: str) -> str | None:
    """
    Pulls just the expanded ticket body out of the model's final response
    (between the '## Expanded Ticket' heading and the '## What This
    Added' heading that always follows it per the prompt's output
    format), so it can be diffed against the original and written out on
    its own - mirrors propose-ticket-edit.py's extract_revised_ticket.
    Anchored on '## What This Added' specifically, not the next '## ' of
    any kind, since the expanded ticket body commonly contains its own
    '### Context From Exploration & Discussion' heading.
    """
    match = EXPANDED_TICKET_RE.search(proposal_text)
    if not match:
        return None
    return match.group(1).strip()


def print_diff(original: str, revised: str) -> None:
    import difflib

    diff = difflib.unified_diff(
        original.splitlines(keepends=True),
        revised.splitlines(keepends=True),
        fromfile="original ticket",
        tofile="expanded ticket",
    )
    diff_text = "".join(diff)
    render.print_line(diff_text if diff_text else "(no textual differences)")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Interactively explore the codebase and grill the human to expand a ticket's acceptance criteria and context.",
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
        "--ticket-file-in",
        type=Path,
        default=None,
        help="Explore this local file instead of fetching from Linear - e.g. "
             "a prior explore-ticket.py/propose-ticket-edit.py output, to "
             "keep refining without touching the live ticket.",
    )
    parser.add_argument(
        "--ticket-file-out",
        type=Path,
        default=None,
        help="Where to write the expanded ticket (default: "
             ".ticket-explored-{ticket-id}.md). Ignored if --no-write is passed.",
    )
    parser.add_argument(
        "--no-write",
        action="store_true",
        help="Only print the expanded ticket/diff - don't write it anywhere.",
    )
    parser.add_argument(
        "--log-level",
        default="info",
        choices=list(verbosity.LEVELS),
        help="Console verbosity (default: info).",
    )
    args = parser.parse_args()
    verbosity.setup_logging(args.log_level)

    if args.ticket_file_in is not None:
        if not args.ticket_file_in.exists():
            lib.die(f"{args.ticket_file_in} not found.")
        render.print_line(f"-- Exploring local file {args.ticket_file_in} instead of fetching {args.ticket_id} from Linear.")
        ticket_content = args.ticket_file_in.read_text(encoding="utf-8")
    else:
        ticket_content = lib.fetch_ticket_text(args.ticket_id)

    render.print_line()
    render.print_line(
        "-- This is an interactive session: the model will explore the "
        "codebase and may stop to ask you clarifying questions below. "
        "Answer each at the '> ' prompt; press Enter with no answer to "
        "let it proceed on its own judgement."
    )

    proposal_text = run_explore_step(ticket_content, args.model)

    render.print_line()
    render.print_line(f"-- Expanded ticket for {args.ticket_id}:")
    render.print_line()
    render.print_line(proposal_text)

    expanded_ticket = extract_expanded_ticket(proposal_text)
    if expanded_ticket is not None:
        render.print_line()
        render.print_line("-- Diff against the original ticket:")
        render.print_line()
        print_diff(ticket_content, expanded_ticket)

    render.print_line()
    if expanded_ticket is None:
        lib.die("Explorer's response didn't match the expected output format (see above) - nothing written.")
    elif args.no_write:
        render.print_line("-- --no-write passed: not writing the expanded ticket anywhere.")
    else:
        out_path = args.ticket_file_out or default_output_path(args.ticket_id)
        tools.write_file_block(str(out_path))(expanded_ticket)
        render.print_line(
            f"-- Wrote expanded ticket to {out_path}. Nothing was sent to Linear "
            f"and {lib.TICKET_FILE} was not touched. Next:\n"
            f"   review-ticket {args.ticket_id} --ticket-file-in {out_path}   # sanity-check it against the codebase\n"
            f"   push_ticket {args.ticket_id} --ticket-file-in {out_path}     # or feed it straight into the pipeline"
        )
    render.print_line(f"-- Token usage: {ai_client.usage}")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""
check-ticket - Fetch a Linear ticket, run the plan prompt, then validate the TDD plan.

Always non-interactive: the planner self-clarifies any ambiguity from
ticket context rather than asking. Any failure (missing command, missing
file, non-zero exit/HTTP error from the backend) aborts immediately with
a reason on stderr - there is no fallback prompting.

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
etc.) - that's gathered by this script via a strict allowlist (see
ALLOWED_CARGO_SUBCOMMANDS) and handed to the validator directly, since
run_command is intentionally refused as a model-callable tool (see
tools.py).

Usage:
    check-ticket <ticket-id> [--ticket-script <path>] [--model <model-id>]

Options:
    --ticket-script     Path to your Linear fetch script.
                        Defaults to the TICKET_SCRIPT env var or 'fetch_ticket.py'
                        in the same directory as this script.
    --model             opencode zen model ID, e.g. deepseek-v4-flash-free.
                        Defaults to "default".
"""

import argparse
import os
import re
import shlex
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from ai_client import AIError, DEFAULT_MODEL, run_with_tools  # noqa: E402
from render import render_markdown  # noqa: E402
import tools  # noqa: E402

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

SCRIPT_DIR = Path(__file__).resolve().parent
PROMPTS_DIR = SCRIPT_DIR.parent / "prompts"
TICKET_FILE = Path(".ticket.md")
PLAN_FILE = Path(".tdd-plan.md")
UPDATED_PLAN_FILE = Path(".updated-plan.md")

# Cleared at the start of every run so this is always a clean single-shot
# attempt - no leftover state from a prior run for the model to stumble
# on, find ambiguous, or waste a tool-call turn checking for.
STALE_FILES = (TICKET_FILE, PLAN_FILE, UPDATED_PLAN_FILE)

PLAN_PROMPT_FILE = PROMPTS_DIR / "plan.prompt.md"
VALIDATE_PROMPT_FILE = PROMPTS_DIR / "validate-coverage.prompt.md"

# Always injected. Instructs the planner to self-clarify before planning,
# since this script has no path for the user to answer follow-up questions.
AUTO_PREAMBLE = (
    "Before producing the TDD plan, identify any ambiguities or missing details "
    "in the ticket. For each one, state the question and then answer it with your "
    "best inference from the ticket context. Then produce the full TDD plan.\n\n"
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def die(msg: str) -> None:
    print(f"error: {msg}", file=sys.stderr)
    sys.exit(1)


def load_prompt_body(prompt_file: Path) -> str:
    """
    Read a prompts/*.prompt.md file and return its role/steps/rules body,
    stripped of the YAML frontmatter and the trailing '## Task' example
    block. That block is written for VS Code's chat composer - #file:
    autocomplete and ${workspaceFolder} - which has no meaning here.

    Reading the file fresh on every run means edits to the prompt
    templates take effect here without touching this script.
    """
    if not prompt_file.exists():
        die(f"Prompt template not found: {prompt_file}")
    text = prompt_file.read_text(encoding="utf-8")

    if text.startswith("---"):
        end = text.find("\n---\n", 3)
        if end != -1:
            text = text[end + len("\n---\n"):]

    body, _, _ = text.partition("\n## Task")
    body = body.rstrip()
    if body.endswith("---"):
        body = body[:-3].rstrip()
    return body


LIST_MARKER_RE = re.compile(r"^(?:[-*]|\d+[.)])\s+")
BACKTICK_TOKEN_RE = re.compile(r"`([^`]+)`")


def extract_plan_files(plan_content: str) -> list[str]:
    """
    Pull file paths out of the plan's '## Implementation Plan' section.
    The plan prompt's template uses '- `path`: change' bullets, but
    model output is not deterministic about list style (numbered lists,
    em-dash separators instead of colons, etc.) - so this tolerates any
    -/*/numbered list marker and pulls the path from the first
    backtick-quoted token on the line rather than assuming a fixed
    separator after it.
    """
    match = re.search(
        r"^## Implementation Plan\s*\n(.*?)(?:\n## |\Z)",
        plan_content,
        re.DOTALL | re.MULTILINE,
    )
    if not match:
        return []
    paths = []
    for line in match.group(1).splitlines():
        line = line.strip()
        if not LIST_MARKER_RE.match(line):
            continue
        line = LIST_MARKER_RE.sub("", line, count=1)
        backtick_match = BACKTICK_TOKEN_RE.search(line)
        if backtick_match:
            path = backtick_match.group(1).strip()
        else:
            path = line.split(":", 1)[0].split(" - ", 1)[0].strip()
        if path:
            paths.append(path)
    return paths


def gather_plan_file_context(plan_content: str) -> tuple[str, set[str]]:
    """
    Plan and validate run as separate sessions with clean context
    windows - the validator has no memory of which files the planner
    looked at. But the plan's own '## Implementation Plan' section is a
    curated prediction of what the validator will need too, so read
    those files here (host-side, not a model tool call) and hand them
    to the validator already in its initial prompt, instead of making it
    rediscover the same files from scratch.

    This is deliberately narrower than "every file the planner read" -
    planning involves speculative exploration (checking an existing
    similar module, etc.) that doesn't belong in the validator's
    context. The Implementation Plan list is the planner's stated
    conclusion, not its scratch work.

    Falls back to listing a missing path's parent directory -
    implementations sometimes land under a different name than planned.
    Returns (formatted text block, set of paths actually read - safe to
    mark as preloaded so a redundant read_file call is deduped).
    """
    paths = extract_plan_files(plan_content)
    if not paths:
        return "(plan's Implementation Plan section listed no file paths)", set()

    blocks = []
    read_paths: set[str] = set()
    for path_str in paths:
        file_path = Path(path_str)
        if file_path.is_file():
            content = file_path.read_text(encoding="utf-8", errors="replace")
            blocks.append(f"### {path_str}\n```\n{content}\n```")
            read_paths.add(path_str)
            continue

        parent = file_path.parent
        if parent.is_dir():
            entries = sorted(p.name for p in parent.iterdir() if p.is_file())
            listing = "\n".join(f"- {e}" for e in entries) or "(empty)"
            blocks.append(
                f"### {path_str} - not found at this exact path\n"
                f"Actual contents of `{parent}/`:\n{listing}"
            )
        else:
            blocks.append(
                f"### {path_str} - not found, and parent directory `{parent}/` "
                f"does not exist either"
            )

    return "\n\n".join(blocks), read_paths


CARGO_COMMAND_RE = re.compile(r"`(cargo [^`]+)`")

# The plan's text traces back to ticket content fetched from Linear -
# external, untrusted input. Never shell=True it: only allow `cargo
# <subcommand>` invocations through a strict allowlist, executed as an
# argv list (no shell), so no amount of `; rm -rf .`-style content
# smuggled into a ticket can do anything but fail to match. This runs on
# the host, not as a model tool call - run_command is refused as a tool
# (see tools.py) precisely because we haven't designed a safe way to let
# the model choose arbitrary commands; this allowlist is that design for
# the one case (cargo verification commands named in AC) we need today.
ALLOWED_CARGO_SUBCOMMANDS = {"test", "fmt", "clippy", "check", "build"}


def extract_plan_commands(plan_content: str) -> list[list[str]]:
    """
    Acceptance criteria sometimes name an exact command as the bar to
    clear (e.g. '`cargo test -p foo` passes'). Run literally what's
    named rather than guessing a toolchain invocation - file contents
    alone can never answer "does the test suite pass." Only commands
    that tokenize to `cargo <allowed subcommand> ...` with no shell
    metacharacters are accepted; anything else is silently skipped.
    """
    commands = []
    seen = set()
    for raw in CARGO_COMMAND_RE.findall(plan_content):
        if raw in seen:
            continue
        seen.add(raw)
        try:
            tokens = shlex.split(raw)
        except ValueError:
            continue
        if len(tokens) < 2 or tokens[0] != "cargo":
            continue
        if tokens[1] not in ALLOWED_CARGO_SUBCOMMANDS:
            continue
        if any(ch in raw for ch in ";|&$><\n"):
            continue
        commands.append(tokens)
    return commands


def gather_build_status(plan_content: str) -> str:
    commands = extract_plan_commands(plan_content)
    if not commands:
        return "(no commands matching the cargo allowlist were named in the plan)"

    blocks = []
    for command_tokens in commands:
        rendered = " ".join(command_tokens)
        print(f"-- Running '{rendered}' for validation evidence ...", flush=True)
        result = subprocess.run(command_tokens, capture_output=True, text=True, check=False)
        output = (result.stdout + result.stderr).strip() or "(no output)"
        blocks.append(
            f"### `{rendered}` (exit code {result.returncode})\n```\n{output}\n```"
        )
    return "\n\n".join(blocks)


def clean_stale_state() -> None:
    for path in STALE_FILES:
        if path.exists():
            path.unlink()
            print(f"-- Removed stale {path} from a previous run", flush=True)


def run_fetch(ticket_script: Path, ticket_id: str) -> None:
    print(f"-- Fetching ticket {ticket_id} ...", flush=True)
    result = subprocess.run(
        [sys.executable, str(ticket_script), ticket_id],
        check=False,
    )
    if result.returncode != 0:
        die(f"Ticket fetch failed (exit {result.returncode}).")
    if not TICKET_FILE.exists():
        die(f"Fetch script completed but {TICKET_FILE} was not written.")
    print(f"   Written -> {TICKET_FILE}", flush=True)


def build_planner_prompt() -> str:
    """
    Embeds the ticket content and a root directory listing directly,
    rather than making the model spend tool-call turns fetching things
    we already know with certainty it's going to want - the planner
    always needs the ticket, and an initial orientation listing is cheap
    to give upfront. Content embedded in the prompt is processed
    identically to content returned from a tool call (it's all just
    tokens in context), so this loses nothing - it just removes the
    variance of whether/when the model gets around to asking for it.
    """
    instructions = load_prompt_body(PLAN_PROMPT_FILE)
    ticket_content = TICKET_FILE.read_text(encoding="utf-8")
    root_listing = tools.list_dir(".")
    return (
        f"{instructions}\n\n---\n\n"
        f"{AUTO_PREAMBLE}"
        f"Here is the ticket ({TICKET_FILE}) - already complete and "
        f"current, no need to read_file it again:\n\n{ticket_content}\n\n"
        f"Here is the project root directory listing - already current, "
        f"no need to list_dir('.') again:\n{root_listing}\n\n"
        f"This is a clean run: {PLAN_FILE} and {UPDATED_PLAN_FILE} do not "
        f"exist yet - there is no prior plan or interrogation output to "
        f"check for, so don't spend a tool call confirming that.\n\n"
        f"Use read_file/list_dir for any other files you need to inspect "
        f"before planning. Produce a TDD plan in the exact format from "
        f"Step 4 above, then use write_file to write it to {PLAN_FILE}. "
        f"Once written, give a short final confirmation as your last "
        f"response with no further tool calls - you do not need to repeat "
        f"the plan's full text."
    )


def build_validator_prompt(
    plan_content: str, plan_file_context: str, build_status_content: str
) -> str:
    """
    Embeds the ticket, the plan, and the files the plan's Implementation
    Plan section names - the validator runs as a fresh session with no
    memory of the plan step, so without this it would have to
    rediscover all of this from scratch via read_file/list_dir. See
    gather_plan_file_context for why this is narrower than "everything
    the planner looked at."
    """
    instructions = load_prompt_body(VALIDATE_PROMPT_FILE)
    ticket_content = TICKET_FILE.read_text(encoding="utf-8")
    return (
        f"{instructions}\n\n---\n\n"
        f"Here is the original ticket ({TICKET_FILE}) - already complete "
        f"and current, no need to read_file it again:\n\n{ticket_content}\n\n"
        f"Here is the TDD plan to validate ({PLAN_FILE}) - already "
        f"complete and current, no need to read_file it again:\n\n"
        f"{plan_content}\n\n"
        f"Here is the current content of the files the plan's "
        f"Implementation Plan section names - already provided, no need "
        f"to read_file these again unless you need a file the plan didn't "
        f"name:\n\n{plan_file_context}\n\n"
        f"Here is the output of running the exact commands the acceptance "
        f"criteria name (e.g. `cargo test`), captured just now - you have "
        f"no way to run these yourself, so this is the evidence for any "
        f"command-based criteria:\n\n{build_status_content}\n\n"
        f"Use read_file/list_dir for anything else you need. Check whether "
        f"the acceptance criteria are fully satisfied, per the steps and "
        f"rules in your instructions. Treat any criterion with no file "
        f"evidence and no command output above as UNKNOWN rather than "
        f"FAIL or PASS."
    )


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(
        description="Fetch a Linear ticket, plan it with TDD, and validate the plan.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument("ticket_id", help="Linear ticket ID, e.g. NEB-42")
    parser.add_argument(
        "--ticket-script",
        default=None,
        help="Path to your Linear fetch script (default: $TICKET_SCRIPT or "
             "fetch_ticket.py next to this script).",
    )
    parser.add_argument(
        "--model",
        default=DEFAULT_MODEL,
        help=f"opencode zen model ID to use (default: {DEFAULT_MODEL}).",
    )
    args = parser.parse_args()
    model = args.model

    # Resolve ticket fetch script
    ticket_script_path = (
        Path(args.ticket_script)
        if args.ticket_script
        else Path(os.environ.get("TICKET_SCRIPT", SCRIPT_DIR / "fetch_ticket.py"))
    )
    if not ticket_script_path.exists():
        die(
            f"Ticket fetch script not found: {ticket_script_path}\n"
            f"  Pass --ticket-script <path> or set the TICKET_SCRIPT env var."
        )

    # ── Step 0: Clean slate ─────────────────────────────────────────────────
    clean_stale_state()

    # ── Step 1: Fetch ticket ────────────────────────────────────────────────
    run_fetch(ticket_script_path, args.ticket_id)

    # ── Step 2: Plan (model reads ticket, writes plan, via tools) ─────────
    try:
        result = run_with_tools(
            build_planner_prompt(),
            tools.READ_WRITE_TOOLS,
            tools.make_executor(preloaded_paths={str(TICKET_FILE)}),
            "plan",
            model=model,
        )
    except (AIError, tools.PipelineAbort) as e:
        die(str(e))
    if not PLAN_FILE.exists():
        die(f"Plan step finished but {PLAN_FILE} was not written.")
    render_markdown(result.text)
    print(f"   Plan written -> {PLAN_FILE}", flush=True)

    # ── Step 3: Validate (model reads via tools; commands run by us) ──────
    plan_content = PLAN_FILE.read_text(encoding="utf-8")
    plan_file_context, plan_file_paths = gather_plan_file_context(plan_content)
    build_status_content = gather_build_status(plan_content)
    preloaded = {str(TICKET_FILE), str(PLAN_FILE)} | plan_file_paths
    try:
        result = run_with_tools(
            build_validator_prompt(plan_content, plan_file_context, build_status_content),
            tools.READ_ONLY_TOOLS,
            tools.make_executor(allow_write=False, preloaded_paths=preloaded),
            "validate",
            model=model,
        )
    except (AIError, tools.PipelineAbort) as e:
        die(str(e))

    render_markdown(result.text)
    print("\n-- Done.", flush=True)


if __name__ == "__main__":
    main()

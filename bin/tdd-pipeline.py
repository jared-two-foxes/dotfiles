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

Build/test commands are read from a project-local TOML config (see
--config) so this isn't Rust/cargo-specific at the tooling level, even
though the default commands and the prompts' assumptions lean Rust today.

Usage:
    tdd-pipeline <ticket-id> [--ticket-script <path>] [--model <model-id>]
                 [--config <path>]
"""

import argparse
import os
import shlex
import subprocess
import sys
import tomllib
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
PIPELINE_CONFIG_FILE = Path(".dev-pipeline.toml")

PLAN_PROMPT_FILE = PROMPTS_DIR / "plan.prompt.md"
TEST_PROMPT_FILE = PROMPTS_DIR / "test-singlepass.prompt.md"
TEST_COVERAGE_PROMPT_FILE = PROMPTS_DIR / "validate-test-coverage.prompt.md"
IMPLEMENT_PROMPT_FILE = PROMPTS_DIR / "implement-singlepass.prompt.md"
REVIEW_PROMPT_FILE = PROMPTS_DIR / "review-singlepass.prompt.md"

AUTO_PREAMBLE = (
    "Before producing the TDD plan, identify any ambiguities or missing details "
    "in the ticket. For each one, state the question and then answer it with your "
    "best inference from the ticket context. Then produce the full TDD plan.\n\n"
)

# Plan only needs to read the ticket and write the plan - no need to
# browse the rest of the workspace. ask_user_prompt is included so an
# ambiguous ticket fails fast with a clear reason instead of the model
# guessing or stalling.
PLAN_TOOLS = [
    tools.READ_FILE_SCHEMA,
    tools.WRITE_FILE_SCHEMA,
    tools.ASK_USER_PROMPT_SCHEMA,
]

# Rust defaults, used only if no project-local config file is present.
DEFAULT_COMMANDS = {
    "build_cmd": "cargo build",
    "test_compile_cmd": "cargo test --no-run",
    "test_cmd": "cargo test",
}

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def die(msg: str) -> None:
    print(f"error: {msg}", file=sys.stderr)
    sys.exit(1)


def load_prompt_body(prompt_file: Path) -> str:
    """
    Read a prompts/*.prompt.md file and strip the YAML frontmatter and
    any trailing VS Code chat-composer example block, leaving the
    role/steps/rules body to inline into a completion-API prompt.
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


def load_pipeline_config(config_path: Path) -> dict:
    commands = dict(DEFAULT_COMMANDS)
    if not config_path.exists():
        print(
            f"-- No {config_path} found, using Rust defaults: {commands}",
            flush=True,
        )
        return commands

    with config_path.open("rb") as f:
        data = tomllib.load(f)

    unknown = set(data) - set(DEFAULT_COMMANDS)
    if unknown:
        die(
            f"{config_path}: unknown key(s) {sorted(unknown)}. "
            f"Allowed: {sorted(DEFAULT_COMMANDS)}"
        )
    for key, value in data.items():
        if not isinstance(value, str) or not value.strip():
            die(f"{config_path}: '{key}' must be a non-empty string")
        commands[key] = value
    return commands


def run_command(command_str: str, label: str) -> subprocess.CompletedProcess:
    """
    Commands come from the project-local pipeline config, which is
    user-authored and trusted (unlike ticket-derived text) - shlex-split
    and run as an argv list, never shell=True, simply because there's no
    reason to invoke a shell for a fixed toolchain command.
    """
    command_tokens = shlex.split(command_str)
    print(f"-- Running '{command_str}' ({label}) ...", flush=True)
    result = subprocess.run(command_tokens, capture_output=True, text=True, check=False)
    if result.stdout:
        print(result.stdout, end="")
    if result.stderr:
        print(result.stderr, end="", file=sys.stderr)
    return result


def find_verdict(text: str, tokens_by_priority: list[str]) -> str | None:
    """
    Look for the first matching verdict token, checking more specific
    tokens before their substrings (e.g. INADEQUATE before ADEQUATE) -
    callers must order tokens_by_priority accordingly.
    """
    for token in tokens_by_priority:
        if token in text:
            return token
    return None


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


# ---------------------------------------------------------------------------
# Prompt builders - all file access happens through tools, so these only
# need to point the model at the right paths, not inline content.
# ---------------------------------------------------------------------------

def build_plan_prompt() -> str:
    instructions = load_prompt_body(PLAN_PROMPT_FILE)
    return (
        f"{instructions}\n\n---\n\n"
        f"{AUTO_PREAMBLE}"
        f"Use read_file to read the ticket at {TICKET_FILE}. Produce a TDD "
        f"plan in the exact format from Step 4 above, then use write_file "
        f"to write it to {PLAN_FILE}. Once written, give a short final "
        f"confirmation as your last response with no further tool calls - "
        f"you do not need to repeat the plan's full text."
    )


def build_test_prompt() -> str:
    instructions = load_prompt_body(TEST_PROMPT_FILE)
    return (
        f"{instructions}\n\n---\n\n"
        f"Write failing tests for the plan at {PLAN_FILE}."
    )


def build_test_coverage_prompt(test_files: list[str]) -> str:
    instructions = load_prompt_body(TEST_COVERAGE_PROMPT_FILE)
    file_list = "\n".join(f"- {p}" for p in test_files)
    return (
        f"{instructions}\n\n---\n\n"
        f"The plan is at {PLAN_FILE}. The following test files were just "
        f"written and should be judged:\n{file_list}\n\n"
        f"Judge whether these tests adequately encode the acceptance "
        f"criteria, per the steps and rules in your instructions."
    )


def build_implement_prompt(test_files: list[str]) -> str:
    instructions = load_prompt_body(IMPLEMENT_PROMPT_FILE)
    file_list = "\n".join(f"- {p}" for p in test_files)
    return (
        f"{instructions}\n\n---\n\n"
        f"The plan is at {PLAN_FILE}. The following failing test files "
        f"must be made to pass without modifying them:\n{file_list}\n\n"
        f"Implement the changes needed."
    )


def build_review_prompt(changed_files: list[str]) -> str:
    instructions = load_prompt_body(REVIEW_PROMPT_FILE)
    file_list = "\n".join(f"- {p}" for p in changed_files)
    return (
        f"{instructions}\n\n---\n\n"
        f"The plan is at {PLAN_FILE}. The following files were changed or "
        f"created:\n{file_list}\n\n"
        f"Review these per the steps and rules in your instructions."
    )


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
    parser.add_argument(
        "--config",
        default=str(PIPELINE_CONFIG_FILE),
        help=f"Path to the build/test command config (default: {PIPELINE_CONFIG_FILE}).",
    )
    args = parser.parse_args()
    model = args.model

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

    commands = load_pipeline_config(Path(args.config))

    # ── Step 1: Fetch ticket ────────────────────────────────────────────────
    run_fetch(ticket_script_path, args.ticket_id)

    # ── Step 2: Plan (model reads ticket, writes plan, via tools) ─────────
    try:
        result = run_with_tools(
            build_plan_prompt(),
            PLAN_TOOLS,
            tools.make_executor(),
            "plan",
            model=model,
        )
    except (AIError, tools.PipelineAbort) as e:
        die(str(e))
    if not PLAN_FILE.exists():
        die(f"Plan step finished but {PLAN_FILE} was not written.")
    render_markdown(result.text)
    print(f"   Plan written -> {PLAN_FILE}", flush=True)

    # ── Step 3: Tests (model reads plan, writes test files, via tools) ────
    test_files: list[str] = []
    try:
        result = run_with_tools(
            build_test_prompt(),
            tools.READ_WRITE_TOOLS,
            tools.make_executor(written_paths=test_files),
            "test",
            model=model,
        )
    except (AIError, tools.PipelineAbort) as e:
        die(str(e))
    if not test_files:
        die("Tester finished without writing any test files.")
    render_markdown(result.text)

    # ── Step 4: Gate - tests compile ───────────────────────────────────────
    result = run_command(commands["test_compile_cmd"], "test compile gate")
    if result.returncode != 0:
        die(f"Tests do not compile (exit {result.returncode}). See output above.")

    # ── Step 5: Gate - tests adequately encode the acceptance criteria ────
    try:
        coverage_result = run_with_tools(
            build_test_coverage_prompt(test_files),
            tools.READ_ONLY_TOOLS,
            tools.make_executor(allow_write=False),
            "test-coverage",
            model=model,
        )
    except (AIError, tools.PipelineAbort) as e:
        die(str(e))
    render_markdown(coverage_result.text)
    verdict = find_verdict(
        coverage_result.text, ["INCOMPLETE REVIEW", "INADEQUATE", "ADEQUATE"]
    )
    if verdict != "ADEQUATE":
        die(f"Test coverage gate did not pass (verdict: {verdict or 'unknown'}).")

    # ── Step 6: Run tests - green means done ───────────────────────────────
    result = run_command(commands["test_cmd"], "initial test run")
    if result.returncode == 0:
        print("\n-- Tests already pass against existing code. Success.", flush=True)
        return

    # ── Step 7: Implement (test files write-protected) ────────────────────
    try:
        result = run_with_tools(
            build_implement_prompt(test_files),
            tools.READ_WRITE_TOOLS,
            tools.make_executor(
                written_paths=(changed_files := []), protected_paths=set(test_files)
            ),
            "implement",
            model=model,
        )
    except (AIError, tools.PipelineAbort) as e:
        die(str(e))
    if not changed_files:
        die("Implementor finished without writing any files.")
    render_markdown(result.text)

    # ── Step 8: Gate - code compiles ────────────────────────────────────────
    result = run_command(commands["build_cmd"], "build gate")
    if result.returncode != 0:
        die(f"Code does not compile (exit {result.returncode}). See output above.")

    # ── Step 9: Gate - tests pass (no second implementation attempt) ──────
    result = run_command(commands["test_cmd"], "post-implementation test run")
    if result.returncode != 0:
        die(
            f"Tests still fail after implementation (exit {result.returncode}). "
            f"This is a single-shot pipeline - no second attempt. See output above."
        )

    # ── Step 10: Gate - code review ─────────────────────────────────────────
    try:
        review_result = run_with_tools(
            build_review_prompt(changed_files),
            tools.READ_ONLY_TOOLS,
            tools.make_executor(allow_write=False),
            "review",
            model=model,
        )
    except (AIError, tools.PipelineAbort) as e:
        die(str(e))
    render_markdown(review_result.text)
    verdict = find_verdict(review_result.text, ["CHANGES REQUESTED", "APPROVED"])
    if verdict != "APPROVED":
        die(f"Code review gate did not pass (verdict: {verdict or 'unknown'}).")

    # ── Step 11: Success ─────────────────────────────────────────────────────
    print("\n-- Implementation complete, tests pass, review approved. Success.", flush=True)


if __name__ == "__main__":
    main()

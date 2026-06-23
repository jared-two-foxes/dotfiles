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
    tdd-pipeline <ticket-id> [--model <model-id>] [--config <path>]
"""

import argparse
import shlex
import subprocess
import sys
import tomllib
import urllib.error
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import ai_client  # noqa: E402
from ai_client import AIError, DEFAULT_MODEL, run_with_tools  # noqa: E402
import fetch_ticket as ticket_source  # noqa: E402
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

# The ticket is embedded directly in the plan prompt and the plan text
# is returned (not written by the model itself - see write_file_block in
# main()), so the plan step never needs write access; read-only tools
# cover browsing the rest of the workspace, and ask_user_prompt lets an
# ambiguous ticket fail fast with a clear reason instead of the model
# guessing or stalling.
PLAN_TOOLS = tools.READ_ONLY_TOOLS

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
    print(f"-- Token usage so far: {ai_client.usage}", file=sys.stderr)
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


def fetch_ticket_text(ticket_id: str) -> str:
    """
    Calls fetch_ticket.py's fetch_ticket()/render() directly and returns
    the rendered markdown - no subprocess, no file I/O here. The caller
    pipes the result through tools.write_file_block to persist it, and
    passes the same in-memory string straight into the prompt builders
    instead of re-reading it off disk.
    """
    print(f"-- Fetching ticket {ticket_id} ...", flush=True)
    try:
        data = ticket_source.fetch_ticket(ticket_id)
    except urllib.error.HTTPError as e:
        die(f"Ticket fetch failed: HTTP {e.code}: {e.read().decode()}")
    return ticket_source.render(data)


# ---------------------------------------------------------------------------
# Prompt builders - all file access happens through tools, so these only
# need to point the model at the right paths, not inline content.
# ---------------------------------------------------------------------------

def build_plan_prompt(ticket_text: str) -> str:
    instructions = load_prompt_body(PLAN_PROMPT_FILE)
    return (
        f"{instructions}\n\n---\n\n"
        f"{AUTO_PREAMBLE}"
        f"Here is the ticket ({TICKET_FILE}) - already complete and "
        f"current, no need to read_file it again:\n\n{ticket_text}\n\n"
        f"Use read_file/list_dir for any other files you need to inspect "
        f"before planning. Produce a TDD plan in the exact format from "
        f"Step 4 above. Your final response (no further tool calls) must "
        f"be exactly that plan text - the caller writes it to {PLAN_FILE} "
        f"itself, so do not call write_file and do not add any chat "
        f"header or commentary around the plan."
    )


def build_test_prompt(plan_text: str) -> str:
    instructions = load_prompt_body(TEST_PROMPT_FILE)
    return (
        f"{instructions}\n\n---\n\n"
        f"Here is the TDD plan ({PLAN_FILE}) - already complete and "
        f"current, no need to read_file it again:\n\n{plan_text}\n\n"
        f"Write failing tests for this plan."
    )


def build_test_coverage_prompt(test_files: list[str], plan_text: str) -> str:
    instructions = load_prompt_body(TEST_COVERAGE_PROMPT_FILE)
    file_list = "\n".join(f"- {p}" for p in test_files)
    return (
        f"{instructions}\n\n---\n\n"
        f"Here is the TDD plan ({PLAN_FILE}) - already complete and "
        f"current, no need to read_file it again:\n\n{plan_text}\n\n"
        f"The following test files were just written and should be "
        f"judged:\n{file_list}\n\n"
        f"Judge whether these tests adequately encode the acceptance "
        f"criteria, per the steps and rules in your instructions."
    )


def build_implement_prompt(test_files: list[str], plan_text: str) -> str:
    instructions = load_prompt_body(IMPLEMENT_PROMPT_FILE)
    file_list = "\n".join(f"- {p}" for p in test_files)
    return (
        f"{instructions}\n\n---\n\n"
        f"Here is the TDD plan ({PLAN_FILE}) - already complete and "
        f"current, no need to read_file it again:\n\n{plan_text}\n\n"
        f"The following failing test files must be made to pass without "
        f"modifying them:\n{file_list}\n\n"
        f"Implement the changes needed."
    )


def build_review_prompt(changed_files: list[str], plan_text: str) -> str:
    instructions = load_prompt_body(REVIEW_PROMPT_FILE)
    file_list = "\n".join(f"- {p}" for p in changed_files)
    return (
        f"{instructions}\n\n---\n\n"
        f"Here is the TDD plan ({PLAN_FILE}) - already complete and "
        f"current, no need to read_file it again:\n\n{plan_text}\n\n"
        f"The following files were changed or created:\n{file_list}\n\n"
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

    commands = load_pipeline_config(Path(args.config))

    # ── Step 1: Fetch ticket ────────────────────────────────────────────────
    ticket_text = fetch_ticket_text(args.ticket_id)
    tools.write_file_block(str(TICKET_FILE))(ticket_text)

    # ── Step 2: Plan (ticket embedded in prompt; plan text returned) ──────
    try:
        result = run_with_tools(
            build_plan_prompt(ticket_text),
            PLAN_TOOLS,
            tools.make_executor(allow_write=False, preloaded_paths={str(TICKET_FILE)}),
            "plan",
            model=model,
            summarize_call=tools.summarize_tool_call,
        )
    except (AIError, tools.PipelineAbort) as e:
        die(str(e))
    if "## Acceptance Criteria" not in result.text:
        render_markdown(result.text)
        die("Planner did not produce a valid plan (see output above).")
    print("-- Plan generated, writing to disk ...", flush=True)
    plan_text = tools.write_file_block(str(PLAN_FILE))(result.text)
    render_markdown(plan_text)

    # ── Step 3: Tests (model reads plan, writes test files, via tools) ────
    test_files: list[str] = []
    try:
        result = run_with_tools(
            build_test_prompt(plan_text),
            tools.READ_WRITE_TOOLS,
            tools.make_executor(written_paths=test_files),
            "test",
            model=model,
            summarize_call=tools.summarize_tool_call,
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
            build_test_coverage_prompt(test_files, plan_text),
            tools.READ_ONLY_TOOLS,
            tools.make_executor(allow_write=False),
            "test-coverage",
            model=model,
            summarize_call=tools.summarize_tool_call,
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
        print(f"-- Token usage: {ai_client.usage}", flush=True)
        return

    # ── Step 7: Implement (test files write-protected) ────────────────────
    try:
        result = run_with_tools(
            build_implement_prompt(test_files, plan_text),
            tools.READ_WRITE_TOOLS,
            tools.make_executor(
                written_paths=(changed_files := []), protected_paths=set(test_files)
            ),
            "implement",
            model=model,
            summarize_call=tools.summarize_tool_call,
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
            build_review_prompt(changed_files, plan_text),
            tools.READ_ONLY_TOOLS,
            tools.make_executor(allow_write=False),
            "review",
            model=model,
            summarize_call=tools.summarize_tool_call,
        )
    except (AIError, tools.PipelineAbort) as e:
        die(str(e))
    render_markdown(review_result.text)
    verdict = find_verdict(review_result.text, ["CHANGES REQUESTED", "APPROVED"])
    if verdict != "APPROVED":
        die(f"Code review gate did not pass (verdict: {verdict or 'unknown'}).")

    # ── Step 11: Success ─────────────────────────────────────────────────────
    print("\n-- Implementation complete, tests pass, review approved. Success.", flush=True)
    print(f"-- Token usage: {ai_client.usage}", flush=True)


if __name__ == "__main__":
    main()

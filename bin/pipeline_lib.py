"""
pipeline_lib - shared step library for check-ticket.py, tdd-pipeline.py,
and resolve-ticket.py.

check-ticket.py (fetch -> plan -> validate coverage, report-only) and
tdd-pipeline.py (fetch -> plan -> test -> implement -> review, with hard
gates) used to duplicate the fetch/plan logic independently, with small
divergences between the two copies. resolve-ticket.py composes both
flows (run check-ticket's validate step, then continue straight into
tdd-pipeline's test/implement/review steps if it found gaps, without
re-fetching the ticket or re-running the plan step). That composition is
only possible cleanly if the step logic lives in one importable module
instead of two hyphenated, non-importable CLI scripts - hence this file.

Each CLI script keeps its own argparse setup and main() control flow (so
each script's console narrative stays its own); everything else - prompt
builders, the run_with_tools call shapes, the validator's evidence
gathering, the build/test command plumbing - lives here.

Functions named build_*_prompt() are pure string builders. Functions
named run_*_step()/run_*_gate() wrap a build_*_prompt() call with its
run_with_tools call, error handling (die() on AIError/PipelineAbort),
result validation, and console rendering - the same block every caller
of that step needs, so the only thing left at each CLI script's call
site is the step name and the variables it threads to the next step.
"""

import json
import re
import shlex
import subprocess
import sys
import tomllib
import urllib.error
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

import ai_client
from ai_client import AIError, run_with_tools
import fetch_ticket as ticket_source
from render import render_markdown
import tools

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

SCRIPT_DIR = Path(__file__).resolve().parent
PROMPTS_DIR = SCRIPT_DIR.parent / "prompts"
TICKET_FILE = Path(".ticket.md")
PLAN_FILE = Path(".tdd-plan.md")
UPDATED_PLAN_FILE = Path(".updated-plan.md")
PIPELINE_CONFIG_FILE = Path(".dev-pipeline.toml")

# Used only by resolve-ticket.py's re-entrant flow.
GAP_PLAN_FILE = Path(".gap-plan.md")
PIPELINE_LOG_FILE = Path(".pipeline-log.jsonl")

# Cleared at the start of every run so this is always a clean single-shot
# attempt - no leftover state from a prior run for the model to stumble
# on, find ambiguous, or waste a tool-call turn checking for. Used only
# by check-ticket.py - resolve-ticket.py is re-entrant by design and
# persists state across invocations instead (see reset_pipeline_state
# for its explicit --reset opt-out). Includes GAP_PLAN_FILE since
# check-ticket.py now runs the narrow step too (same .gap-plan.md
# resolve-ticket.py reads on startup) - a stale gap plan from an earlier
# ticket would otherwise look like a valid, already-narrowed result.
STALE_FILES = (TICKET_FILE, PLAN_FILE, UPDATED_PLAN_FILE, GAP_PLAN_FILE)

# Used only by resolve-ticket.py's --reset flag. Deliberately excludes
# any test/implementation source file the pipeline wrote - those are
# real work product, not pipeline scaffolding; reverting them is the
# user's own job via git.
RESETTABLE_FILES = (TICKET_FILE, PLAN_FILE, GAP_PLAN_FILE, PIPELINE_LOG_FILE)

# Default model for the narrow step specifically, distinct from the
# generic ai_client.DEFAULT_MODEL used by every other step. Chosen by
# trialling check-ticket.py against SA-452 across several models at
# similar price tiers: flash/budget-tier models (deepseek-v4-flash,
# kimi-k2.6, grok-build-0.1) consistently misread a criterion that named
# a new file as requiring an actual new file, instead of recognizing the
# work already lived in the codebase's existing convention file
# (accounting_webhooks.rs, alongside its sibling config struct). glm-5
# was the cheapest model tested that got this right.
NARROW_DEFAULT_MODEL = "glm-5"

PLAN_PROMPT_FILE = PROMPTS_DIR / "plan.prompt.md"
NARROW_PROMPT_FILE = PROMPTS_DIR / "narrow-plan.prompt.md"
TEST_PROMPT_FILE = PROMPTS_DIR / "test-singlepass.prompt.md"
TEST_COVERAGE_PROMPT_FILE = PROMPTS_DIR / "validate-test-coverage.prompt.md"
IMPLEMENT_PROMPT_FILE = PROMPTS_DIR / "implement-singlepass.prompt.md"
REVIEW_PROMPT_FILE = PROMPTS_DIR / "review-singlepass.prompt.md"
TEST_CRITERION_PROMPT_FILE = PROMPTS_DIR / "test-criterion.prompt.md"
IMPLEMENT_CRITERION_PROMPT_FILE = PROMPTS_DIR / "implement-criterion.prompt.md"

# Always injected. Instructs the planner to self-clarify before planning,
# since none of these scripts have a path for a human to answer follow-up
# questions mid-run.
AUTO_PREAMBLE = (
    "Before producing the TDD plan, identify any ambiguities or missing details "
    "in the ticket. For each one, state the question and then answer it with your "
    "best inference from the ticket context. Then produce the full TDD plan.\n\n"
)

# Rust defaults, used only if no project-local config file is present.
# test_filter_cmd is used only by resolve-ticket.py's per-criterion loop
# (run_scoped_test) - {filter} is substituted with the qualified test
# name recorded for that criterion. Compiling can't be scoped to one
# test (a test binary compiles everything in it regardless of which
# test you'll filter at runtime), so there's no filtered equivalent of
# test_compile_cmd - only the run is ever scoped.
#
# fmt_fix_cmd/clippy_fix_cmd/fmt_check_cmd/clippy_cmd are used only by
# resolve-ticket.py's run_lint_gate - lint/style checks run once, after
# every criterion is implemented and passing, right before code review -
# not as acceptance-criteria evidence (see ALLOWED_CARGO_SUBCOMMANDS).
# The *_fix_cmd entries attempt the mechanical, no-judgment-call fix
# before the *_check_cmd/clippy_cmd gate gets to fail anything.
DEFAULT_COMMANDS = {
    "build_cmd": "cargo build",
    "test_compile_cmd": "cargo test --no-run",
    "test_cmd": "cargo test",
    "test_filter_cmd": "cargo test {filter}",
    "fmt_fix_cmd": "cargo fmt",
    "clippy_fix_cmd": "cargo clippy --fix --allow-dirty --allow-staged --allow-no-vcs",
    "fmt_check_cmd": "cargo fmt -- --check",
    "clippy_cmd": "cargo clippy -- -D warnings",
}

# ---------------------------------------------------------------------------
# Generic helpers
# ---------------------------------------------------------------------------


def die(msg: str) -> None:
    print(f"error: {msg}", file=sys.stderr)
    print(f"-- Token usage so far: {ai_client.usage}", file=sys.stderr)
    sys.exit(1)


def load_prompt_body(prompt_file: Path) -> str:
    """
    Read a prompts/*.prompt.md file and return its role/steps/rules body,
    stripped of the YAML frontmatter and the trailing '## Task' example
    block. That block is written for VS Code's chat composer - #file:
    autocomplete and ${workspaceFolder} - which has no meaning here.

    Reading the file fresh on every run means edits to the prompt
    templates take effect here without touching any of the CLI scripts.
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


def clean_stale_state() -> None:
    for path in STALE_FILES:
        if path.exists():
            path.unlink()
            print(f"-- Removed stale {path} from a previous run", flush=True)


def reset_pipeline_state() -> None:
    """
    Used only by resolve-ticket.py's --reset flag. See RESETTABLE_FILES
    for what's cleared and why source files are deliberately excluded.
    """
    for path in RESETTABLE_FILES:
        if path.exists():
            path.unlink()
            print(f"-- Reset: removed {path}", flush=True)


# ---------------------------------------------------------------------------
# Diagnostic log - resolve-ticket.py only. Purely informational: "why did
# this fail last time" for a human reading the next invocation's output.
# Resumption decisions never consult this - check() always re-inspects
# real output state for that, so a stale or missing log entry can't
# mislead the pipeline into the wrong resume point, only a human glancing
# at the wrong "last failure" note.
# ---------------------------------------------------------------------------


def log_event(block: str, status: str, error: str | None = None, criterion: str | None = None) -> None:
    entry = {
        "block": block,
        "criterion": criterion,
        "ts": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "status": status,
        "error": error,
    }
    with PIPELINE_LOG_FILE.open("a", encoding="utf-8") as f:
        f.write(json.dumps(entry) + "\n")


def die_with_log(block: str, msg: str, criterion: str | None = None) -> None:
    """
    Like die(), but also records the failure to the diagnostic log first
    - used by every resolve-ticket.py-specific failure path. die() itself
    is untouched so check-ticket.py/tdd-pipeline.py keep their existing
    behavior exactly (they never write to PIPELINE_LOG_FILE).
    """
    log_event(block, "failed", error=msg, criterion=criterion)
    die(msg)


def show_last_failure() -> None:
    """
    Prints the most recent log entry if it was a failure, so a re-entrant
    run immediately shows "what broke last time" instead of making the
    user scroll back through old terminal output.
    """
    if not PIPELINE_LOG_FILE.exists():
        return
    lines = PIPELINE_LOG_FILE.read_text(encoding="utf-8").strip().splitlines()
    if not lines:
        return
    try:
        last = json.loads(lines[-1])
    except json.JSONDecodeError:
        return
    if last.get("status") != "failed":
        return
    where = last.get("block", "?")
    if last.get("criterion"):
        where += f" (criterion: {last['criterion']})"
    print(f"-- Note: last attempt failed at {where}: {last.get('error')}", flush=True)


# ---------------------------------------------------------------------------
# Generic block/walk helper - used for the linear planning pipeline
# (fetch -> plan -> narrow). The per-criterion implementation loop is
# NOT forced through this same walker - it has a real early-exit branch
# (test unexpectedly green at the red-check means the gap didn't
# reproduce; skip straight to the next criterion) that doesn't fit "run,
# then must satisfy check" cleanly. That loop applies the identical
# check-before-run principle by hand instead.
# ---------------------------------------------------------------------------


@dataclass
class Block:
    name: str
    check: Callable[[], bool]
    run: Callable[[], None]


def walk(blocks: list[Block]) -> None:
    for block in blocks:
        if block.check():
            print(f"-- {block.name}: already satisfied, skipping", flush=True)
            continue
        print(f"-- {block.name}: running ...", flush=True)
        block.run()
        if not block.check():
            die_with_log(block.name, f"{block.name} ran but its postcondition still isn't satisfied.")


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


# ---------------------------------------------------------------------------
# Ticket fetch
# ---------------------------------------------------------------------------


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
# Plan step
# ---------------------------------------------------------------------------


def build_plan_prompt(ticket_content: str) -> str:
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
        f"Use read_file/list_dir/search_files for any other files you need "
        f"to inspect before planning - but only files you have a concrete "
        f"reason to need, not speculative browsing; every tool call you "
        f"make gets resent in full on every subsequent turn, so prefer one "
        f"targeted search_files call over open-ended directory browsing "
        f"when you're looking for something specific. Produce a TDD plan "
        f"in the exact format from Step 4 above. Your final response (no "
        f"further tool calls) must "
        f"be exactly that plan text - the caller writes it to {PLAN_FILE} "
        f"itself, so do not call write_file and do not add any chat "
        f"header or commentary around the plan."
    )


def run_plan_step(ticket_content: str, model: str) -> str:
    """
    Runs the plan step end to end: prompt, run_with_tools, validity
    check, write to disk, render. Returns plan_text for the caller to
    thread into whichever step comes next.
    """
    try:
        result = run_with_tools(
            build_plan_prompt(ticket_content),
            tools.READ_ONLY_TOOLS,
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
    plan_content = tools.write_file_block(str(PLAN_FILE))(result.text)
    render_markdown(plan_content)
    return plan_content


# ---------------------------------------------------------------------------
# Validate step (coverage of the plan against the current codebase)
# ---------------------------------------------------------------------------

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
#
# Only `test` - not `build`/`check`/`fmt`/`clippy`. `build`/`check` are
# subsumed by `test` (compiling the test binary already compiles the
# lib/bin first, so a passing test run is strictly stronger evidence
# than a passing build/check) - running them separately as evidence
# would just be redundant work for no extra signal. `fmt`/`clippy` are
# lint/style checks, not evidence of whether a feature is implemented -
# they don't belong in acceptance-criteria evidence-gathering at all;
# see run_lint_gate, which runs them once at the end of the
# implementation pipeline instead, right before code review.
ALLOWED_CARGO_SUBCOMMANDS = {"test"}


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


COMMAND_OUTPUT_MAX_LINES = 100


def truncate_command_output(output: str, max_lines: int = COMMAND_OUTPUT_MAX_LINES) -> str:
    """
    Cap output to its last `max_lines` lines - a position-based fallback
    for when no subcommand-specific pattern applies (see
    summarize_command_output) or matched nothing. Used directly for a
    clean pass with no signal lines to extract, where "no output of
    note" is itself the evidence.
    """
    lines = output.splitlines()
    if len(lines) <= max_lines:
        return output
    omitted = len(lines) - max_lines
    return f"(omitted {omitted} earlier lines)\n" + "\n".join(lines[-max_lines:])


# Pulls out the lines that actually carry evidence from `cargo test`'s
# output - the pass/fail summary and any failure messages, not the
# per-test progress noise. ALLOWED_CARGO_SUBCOMMANDS only ever gathers
# `test` output now, so this is the only pattern needed; kept as a dict
# (rather than a single regex) so a future evidence-relevant subcommand
# can be added without changing summarize_command_output's shape.
_TEST_SIGNAL_RE = re.compile(r"FAILED|^test result:|panicked at|^---- ")

COMMAND_SIGNAL_PATTERNS = {
    "test": _TEST_SIGNAL_RE,
}


def summarize_command_output(subcommand: str, output: str) -> str:
    """
    Extract just the evidence-bearing lines for `subcommand`'s output
    before it's embedded in the validator's prompt - a plain tail (see
    truncate_command_output) would silently drop clippy/build/check
    errors and fmt's per-file diffs that occur before the last
    COMMAND_OUTPUT_MAX_LINES lines, since those subcommands don't
    concentrate their signal at the end the way `cargo test` does.

    Falls back to a tail truncation if there's no pattern for this
    subcommand, or the pattern matched nothing - either a clean pass
    with no error/warning/diff lines to report (itself valid evidence),
    or output that didn't look like what was expected, in which case the
    raw tail is still better than nothing.
    """
    pattern = COMMAND_SIGNAL_PATTERNS.get(subcommand)
    if pattern is None:
        return truncate_command_output(output)
    matched = [line for line in output.splitlines() if pattern.search(line)]
    if not matched:
        return truncate_command_output(output)
    return truncate_command_output("\n".join(matched))


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
        output = summarize_command_output(command_tokens[1], output)
        blocks.append(
            f"### `{rendered}` (exit code {result.returncode})\n```\n{output}\n```"
        )
    return "\n\n".join(blocks)


# ---------------------------------------------------------------------------
# Narrow step (check-ticket.py and resolve-ticket.py) - same
# evidence-gathering a coverage validator would need, but the output is
# plan-shaped (like the plan step's own output) instead of a prose
# verdict: check-ticket.py reports completion by counting the remaining
# '## Acceptance Criteria' bullets, and resolve-ticket.py's check() is
# "file exists, well-formed" rather than a re-judgment of freshness on
# every resume. Both write to the same GAP_PLAN_FILE, so a remaining-gap
# report from check-ticket.py is exactly what resolve-ticket.py needs to
# re-enter straight into its per-criterion implementation loop.
# ---------------------------------------------------------------------------


def build_narrow_prompt(
    ticket_content: str, plan_content: str, plan_file_context: str, build_status_content: str
) -> str:
    instructions = load_prompt_body(NARROW_PROMPT_FILE)
    return (
        f"{instructions}\n\n---\n\n"
        f"Here is the original ticket ({TICKET_FILE}) - already complete "
        f"and current, no need to read_file it again:\n\n{ticket_content}\n\n"
        f"Here is the TDD plan to narrow ({PLAN_FILE}) - already "
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
        f"Use read_file/list_dir/search_files for anything else you need - "
        f"when hunting for evidence of a criterion across the codebase, "
        f"prefer one targeted search_files call over list_dir-then-read_file "
        f"fishing; every tool call gets resent in full on every subsequent "
        f"turn, so fewer, more targeted calls keep this cheaper without "
        f"costing you any evidence. Narrow the plan to just the criteria "
        f"not yet satisfied, per the steps and rules in your instructions."
    )


def run_narrow_step(ticket_content: str, plan_content: str, model: str) -> str:
    plan_file_context, plan_file_paths = gather_plan_file_context(plan_content)
    build_status_content = gather_build_status(plan_content)
    preloaded = {str(TICKET_FILE), str(PLAN_FILE)} | plan_file_paths
    try:
        result = run_with_tools(
            build_narrow_prompt(ticket_content, plan_content, plan_file_context, build_status_content),
            tools.READ_ONLY_TOOLS,
            tools.make_executor(allow_write=False, preloaded_paths=preloaded),
            "narrow",
            model=model,
            summarize_call=tools.summarize_tool_call,
        )
    except (AIError, tools.PipelineAbort) as e:
        die_with_log("narrow", str(e))
    if "## Acceptance Criteria" not in result.text:
        render_markdown(result.text)
        die_with_log("narrow", "Narrower did not produce a valid gap plan (see output above).")
    print("-- Gap plan generated, writing to disk ...", flush=True)
    gap_plan_content = tools.write_file_block(str(GAP_PLAN_FILE))(result.text)
    render_markdown(gap_plan_content)
    return gap_plan_content


# ---------------------------------------------------------------------------
# Per-criterion parsing/annotation (resolve-ticket.py only)
# ---------------------------------------------------------------------------


def extract_acceptance_criteria(plan_content: str) -> list[str]:
    """
    Pull each '- [ ] ...' line directly under '## Acceptance Criteria' -
    same list-tolerant parsing style as extract_plan_files, applied to
    the criteria section instead of the implementation section. Returns
    the exact bullet line text (including any trailing HTML comment),
    since that's the key used to find/insert this criterion's Test:
    annotation in find_criterion_test/annotate_criterion_test.
    """
    match = re.search(
        r"^## Acceptance Criteria\s*\n(.*?)(?:\n## |\Z)",
        plan_content,
        re.DOTALL | re.MULTILINE,
    )
    if not match:
        return []
    return [
        line.strip()
        for line in match.group(1).splitlines()
        if LIST_MARKER_RE.match(line.strip())
    ]


TEST_ANNOTATION_RE = re.compile(r"^\s*Test:\s*(.+?)\s*::\s*(.+?)\s*$")


def find_criterion_test(plan_content: str, criterion: str) -> tuple[str, str] | None:
    """
    Looks for a 'Test:' sub-line immediately following `criterion`'s
    bullet line. Returns (file_path, qualified_test_name) if found.
    """
    lines = plan_content.splitlines()
    for i, line in enumerate(lines):
        if line.strip() == criterion.strip():
            if i + 1 < len(lines):
                match = TEST_ANNOTATION_RE.match(lines[i + 1])
                if match:
                    return match.group(1).strip(), match.group(2).strip()
            return None
    return None


def annotate_criterion_test(plan_path: Path, criterion: str, file_path: str, test_name: str) -> str:
    """
    Read-modify-write: insert (or replace) a 'Test: <file> :: <name>'
    sub-line directly under `criterion`'s bullet in `plan_path`, so the
    pointer the test-writer reports survives as part of the same
    artifact rather than a separate mapping file. Returns the updated
    content (callers should use this return value instead of re-reading
    the file, same convention as write_file_block).
    """
    content = plan_path.read_text(encoding="utf-8")
    lines = content.splitlines()
    annotation = f"  Test: {file_path} :: {test_name}"
    for i, line in enumerate(lines):
        if line.strip() == criterion.strip():
            if i + 1 < len(lines) and TEST_ANNOTATION_RE.match(lines[i + 1]):
                lines[i + 1] = annotation
            else:
                lines.insert(i + 1, annotation)
            break
    else:
        die_with_log("annotate", f"Could not find criterion in {plan_path} to annotate: {criterion!r}")
    updated = "\n".join(lines) + ("\n" if content.endswith("\n") else "")
    plan_path.write_text(updated, encoding="utf-8")
    print(f"   annotated {plan_path} with test pointer for criterion", flush=True)
    return updated


def criterion_test_exists(file_path: str, qualified_test_name: str) -> bool:
    """
    Cheap sanity check, not full correctness verification: the recorded
    file exists and the test name appears in it. Whether the gap is
    actually closed is determined by running the scoped test (see
    run_scoped_test), not by this check.
    """
    path = Path(file_path)
    if not path.is_file():
        return False
    content = path.read_text(encoding="utf-8", errors="replace")
    leaf = qualified_test_name.rsplit("::", 1)[-1]
    return leaf in content


def run_scoped_test(qualified_test_name: str, commands: dict, label: str) -> subprocess.CompletedProcess:
    command_str = commands["test_filter_cmd"].format(filter=qualified_test_name)
    return run_command(command_str, label)


def run_lint_gate(commands: dict) -> None:
    """
    Runs lint/style checks once, after every criterion is implemented
    and passing - not as acceptance-criteria evidence (see
    ALLOWED_CARGO_SUBCOMMANDS, which deliberately excludes these; lint
    is a code-quality signal, not a behavioral one).

    Attempts the mechanical fix first: clippy --fix for whatever it can
    auto-apply, then fmt to normalize formatting (including whatever
    clippy --fix just rewrote). This isn't a retry - it's deterministic
    tooling with no judgment call involved, not a second attempt at
    anything an LLM step already tried, so it doesn't conflict with this
    pipeline's single-shot philosophy. Runs over the whole project, test
    files included: cargo fmt/clippy --fix are mechanical tools, not
    agentic writes, so there's no risk of them weakening a test's
    assertions the way an LLM implementer might - the write-protection
    that guards implement steps doesn't apply here.

    Whatever the auto-fix can't resolve (most semantic clippy warnings)
    hits the hard gate below, with no further attempt: dies on failure.
    """
    run_command(commands["clippy_fix_cmd"], "clippy auto-fix")
    run_command(commands["fmt_fix_cmd"], "fmt auto-fix")

    result = run_command(commands["fmt_check_cmd"], "fmt check")
    if result.returncode != 0:
        die_with_log(
            "lint",
            f"cargo fmt --check failed (exit {result.returncode}) even after an "
            f"auto-fix attempt. See output above.",
        )
    result = run_command(commands["clippy_cmd"], "clippy")
    if result.returncode != 0:
        die_with_log(
            "lint",
            f"cargo clippy failed (exit {result.returncode}) even after an "
            f"auto-fix attempt. See output above.",
        )


# ---------------------------------------------------------------------------
# Per-criterion test/implement steps (resolve-ticket.py only)
# ---------------------------------------------------------------------------

TEST_WITNESS_RE = re.compile(r"TEST_WITNESS:\s*(.+?)\s*::\s*(.+)$", re.MULTILINE)


def build_test_criterion_prompt(criterion: str, plan_text: str) -> str:
    instructions = load_prompt_body(TEST_CRITERION_PROMPT_FILE)
    return (
        f"{instructions}\n\n---\n\n"
        f"Here is the gap plan ({GAP_PLAN_FILE}) - already complete and "
        f"current, no need to read_file it again:\n\n{plan_text}\n\n"
        f"Write a failing test for exactly this one acceptance criterion, "
        f"and only this one:\n\n{criterion}"
    )


def run_test_for_criterion(criterion: str, plan_text: str, model: str) -> tuple[str, str]:
    test_files: list[str] = []
    try:
        result = run_with_tools(
            build_test_criterion_prompt(criterion, plan_text),
            tools.READ_WRITE_TOOLS,
            tools.make_executor(written_paths=test_files),
            "test-criterion",
            model=model,
            summarize_call=tools.summarize_tool_call,
        )
    except (AIError, tools.PipelineAbort) as e:
        die_with_log("test-criterion", str(e), criterion=criterion)
    if not test_files:
        die_with_log(
            "test-criterion", "Tester finished without writing any test files.", criterion=criterion
        )
    render_markdown(result.text)
    witness = TEST_WITNESS_RE.search(result.text)
    if not witness:
        die_with_log(
            "test-criterion",
            "Tester's final answer did not include a TEST_WITNESS line (see output above).",
            criterion=criterion,
        )
    return witness.group(1).strip(), witness.group(2).strip()


def build_implement_criterion_prompt(criterion: str, plan_text: str, test_file: str) -> str:
    instructions = load_prompt_body(IMPLEMENT_CRITERION_PROMPT_FILE)
    return (
        f"{instructions}\n\n---\n\n"
        f"Here is the gap plan ({GAP_PLAN_FILE}) - already complete and "
        f"current, no need to read_file it again:\n\n{plan_text}\n\n"
        f"This implementation is for exactly this one acceptance "
        f"criterion, and only this one:\n\n{criterion}\n\n"
        f"The failing test that proves it (must be made to pass without "
        f"modifying it): {test_file}"
    )


def run_implement_for_criterion(
    criterion: str, plan_text: str, model: str, test_file: str
) -> list[str]:
    changed_files: list[str] = []
    try:
        result = run_with_tools(
            build_implement_criterion_prompt(criterion, plan_text, test_file),
            tools.READ_WRITE_TOOLS,
            tools.make_executor(written_paths=changed_files, protected_paths={test_file}),
            "implement-criterion",
            model=model,
            summarize_call=tools.summarize_tool_call,
        )
    except (AIError, tools.PipelineAbort) as e:
        die_with_log("implement-criterion", str(e), criterion=criterion)
    if not changed_files:
        die_with_log(
            "implement-criterion", "Implementor finished without writing any files.", criterion=criterion
        )
    render_markdown(result.text)
    return changed_files


# ---------------------------------------------------------------------------
# Test / coverage-gate / implement / review steps
# ---------------------------------------------------------------------------


def build_test_prompt(plan_text: str, scope_note: str | None = None) -> str:
    instructions = load_prompt_body(TEST_PROMPT_FILE)
    scope_block = ""
    if scope_note:
        scope_block = (
            f"\n\nA coverage validator already checked this plan against the "
            f"current codebase and found gaps - write tests ONLY for the "
            f"specific acceptance criteria it lists as failing below; skip "
            f"any criterion not named there, it's already satisfied by "
            f"existing code and tests:\n\n{scope_note}"
        )
    return (
        f"{instructions}\n\n---\n\n"
        f"Here is the TDD plan ({PLAN_FILE}) - already complete and "
        f"current, no need to read_file it again:\n\n{plan_text}\n\n"
        f"Write failing tests for this plan."
        f"{scope_block}"
    )


def build_test_coverage_prompt(
    test_files: list[str], plan_text: str, scope_note: str | None = None
) -> str:
    instructions = load_prompt_body(TEST_COVERAGE_PROMPT_FILE)
    file_list = "\n".join(f"- {p}" for p in test_files)
    scope_block = ""
    if scope_note:
        scope_block = (
            f"\n\nNote: these tests were only meant to cover specific gaps a "
            f"coverage validator found, not every criterion in the plan "
            f"above - judge coverage only against the criteria it listed as "
            f"failing below; do not flag missing coverage for any criterion "
            f"not named there, it's already satisfied elsewhere:\n\n{scope_note}"
        )
    return (
        f"{instructions}\n\n---\n\n"
        f"Here is the TDD plan ({PLAN_FILE}) - already complete and "
        f"current, no need to read_file it again:\n\n{plan_text}\n\n"
        f"The following test files were just written and should be "
        f"judged:\n{file_list}\n\n"
        f"Judge whether these tests adequately encode the acceptance "
        f"criteria, per the steps and rules in your instructions."
        f"{scope_block}"
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


def run_test_step(plan_text: str, model: str, scope_note: str | None = None) -> list[str]:
    test_files: list[str] = []
    try:
        result = run_with_tools(
            build_test_prompt(plan_text, scope_note),
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
    return test_files


def run_test_coverage_gate(
    test_files: list[str], plan_text: str, model: str, scope_note: str | None = None
) -> None:
    try:
        coverage_result = run_with_tools(
            build_test_coverage_prompt(test_files, plan_text, scope_note),
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


def run_implement_step(test_files: list[str], plan_text: str, model: str) -> list[str]:
    changed_files: list[str] = []
    try:
        result = run_with_tools(
            build_implement_prompt(test_files, plan_text),
            tools.READ_WRITE_TOOLS,
            tools.make_executor(written_paths=changed_files, protected_paths=set(test_files)),
            "implement",
            model=model,
            summarize_call=tools.summarize_tool_call,
        )
    except (AIError, tools.PipelineAbort) as e:
        die(str(e))
    if not changed_files:
        die("Implementor finished without writing any files.")
    render_markdown(result.text)
    return changed_files


def run_review_gate(changed_files: list[str], plan_text: str, model: str) -> None:
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

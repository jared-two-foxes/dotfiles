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
import time
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
import toolchains

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

PLAN_PROMPT_FILE = PROMPTS_DIR / "plan.prompt.md"
NARROW_PROMPT_FILE = PROMPTS_DIR / "narrow-plan.prompt.md"
PLAN_NARROW_PROMPT_FILE = PROMPTS_DIR / "plan-narrow.prompt.md"
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

# Per-toolchain defaults (rust/cargo, bazel, cmake/ctest, sveltekit/npm,
# generic typescript/npm), used only if no project-local config file is
# present - see toolchains.py. Detected lazily (see get_toolchain) rather
# than at import time, and cached, since detection reads the project
# root's marker files (Cargo.toml, WORKSPACE, CMakeLists.txt,
# svelte.config.*, package.json) relative to cwd - the same cwd
# convention every other relative path in this module already relies on.
#
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
# not as acceptance-criteria evidence (see extract_plan_commands). Names
# are inherited from the original Rust-only defaults (fmt/clippy) but are
# generic format-fix/lint-fix/format-check/lint-check slots regardless of
# toolchain - not worth a breaking key rename across every existing
# .dev-pipeline.toml for what's just a label. The *_fix_cmd entries
# attempt the mechanical, no-judgment-call fix before the
# *_check_cmd/clippy_cmd gate gets to fail anything.
_toolchain_cache: toolchains.Toolchain | None = None
_toolchain_detected = False


def get_toolchain() -> toolchains.Toolchain:
    """
    Detects the project's toolchain once (by marker file at cwd) and
    caches it for the rest of the process. Falls back to the Rust/cargo
    defaults if nothing is detected, preserving this module's original
    behavior for projects with no recognized marker file and no
    .dev-pipeline.toml override.
    """
    global _toolchain_cache, _toolchain_detected
    if not _toolchain_detected:
        _toolchain_cache = toolchains.detect_toolchain()
        _toolchain_detected = True
    return _toolchain_cache or toolchains.RUST

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


AI_STEP_MAX_ATTEMPTS = 3
AI_STEP_RETRY_BACKOFF_BASE_S = 5.0


def run_ai_step_with_retry(
    step_fn: Callable[[], object],
    label: str,
    criterion: str | None = None,
    max_attempts: int = AI_STEP_MAX_ATTEMPTS,
) -> object:
    """
    Calls step_fn() - a zero-arg closure performing one run_with_tools
    round trip and returning its parsed result - retrying only on
    AIError. tools.PipelineAbort (ask_user_prompt/run_command) propagates
    immediately, unretried: those are deliberate model signals, not
    transient infra failures, and retrying changes nothing about a
    model's decision to ask for clarification or reach for a shell.

    Each retry calls step_fn() completely fresh (new message history
    inside run_with_tools); any written_paths/changed_files accumulator
    a caller threads into its closure must be cleared by step_fn itself
    at the top of each call, since a failed attempt's partial writes
    must not carry over into the next attempt's result.

    Logs every failed attempt via log_event(status="retry") before
    sleeping with exponential backoff (matches ai_client's own
    transient-HTTP-retry backoff shape), so a human reading
    .pipeline-log.jsonl later can see "it flaked twice then succeeded"
    instead of nothing. After max_attempts is exhausted, re-raises the
    last AIError untouched - this helper never itself decides to die,
    that's still each call site's existing except/die_with_log handling.
    """
    attempt = 0
    while True:
        attempt += 1
        try:
            return step_fn()
        except ai_client.StepBudgetExceeded:
            raise
        except AIError as e:
            if attempt >= max_attempts:
                raise
            log_event(label, "retry", error=str(e), criterion=criterion)
            backoff_s = AI_STEP_RETRY_BACKOFF_BASE_S * (2 ** (attempt - 1))
            print(
                f"-- {label}: attempt {attempt}/{max_attempts} failed ({e}), "
                f"retrying in {backoff_s:.0f}s ...",
                flush=True,
            )
            time.sleep(backoff_s)


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
    toolchain = get_toolchain()
    commands = dict(toolchain.commands)
    if not config_path.exists():
        print(
            f"-- Detected toolchain: {toolchain.name}. "
            f"No {config_path} found, using its defaults: {commands}",
            flush=True,
        )
        return commands

    print(f"-- Detected toolchain: {toolchain.name}. Loading overrides from {config_path} ...", flush=True)
    with config_path.open("rb") as f:
        data = tomllib.load(f)

    unknown = set(data) - set(toolchain.commands)
    if unknown:
        die(
            f"{config_path}: unknown key(s) {sorted(unknown)}. "
            f"Allowed: {sorted(toolchain.commands)}"
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
        result = run_ai_step_with_retry(
            lambda: run_with_tools(
                build_plan_prompt(ticket_content),
                tools.READ_ONLY_TOOLS,
                tools.make_executor(allow_write=False, preloaded_paths={str(TICKET_FILE)}),
                "plan",
                model=model,
                summarize_call=tools.summarize_tool_call,
            ),
            "plan",
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
    ticket_content: str, plan_content: str, plan_file_context: str
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
    preloaded = {str(TICKET_FILE), str(PLAN_FILE)} | plan_file_paths
    try:
        result = run_ai_step_with_retry(
            lambda: run_with_tools(
                build_narrow_prompt(ticket_content, plan_content, plan_file_context),
                tools.READ_ONLY_TOOLS,
                tools.make_executor(allow_write=False, preloaded_paths=preloaded),
                "narrow",
                model=model,
                summarize_call=tools.summarize_tool_call,
            ),
            "narrow",
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
# Plan-narrow step (merged) - experimental alternative to running plan and
# narrow as two separate sessions. The model extracts acceptance criteria
# and checks each one against the codebase's current state in one pass,
# using live tools throughout instead of the host pre-reading plan-named
# files and handing them back (see gather_plan_file_context) - that
# handoff only existed to bridge two separate sessions with clean context
# windows; one session needs no bridge. Produces a single artifact, the
# gap plan - there's no separate full-plan output, since the only thing
# that consumed the full plan (run_review_gate's "review against full
# ticket scope") doesn't need criteria that are already satisfied and
# untouched.
# ---------------------------------------------------------------------------


def build_plan_narrow_prompt(ticket_content: str) -> str:
    instructions = load_prompt_body(PLAN_NARROW_PROMPT_FILE)
    root_listing = tools.list_dir(".")
    return (
        f"{instructions}\n\n---\n\n"
        f"{AUTO_PREAMBLE}"
        f"Here is the ticket ({TICKET_FILE}) - already complete and "
        f"current, no need to read_file it again:\n\n{ticket_content}\n\n"
        f"Here is the project root directory listing - already current, "
        f"no need to list_dir('.') again:\n{root_listing}\n\n"
        f"This is a clean run: {GAP_PLAN_FILE} does not exist yet - there "
        f"is no prior gap plan to check for, so don't spend a tool call "
        f"confirming that.\n\n"
        f"Use read_file/list_dir/search_files for anything else you need - "
        f"but only files you have a concrete reason to need, not "
        f"speculative browsing; every tool call you make gets resent in "
        f"full on every subsequent turn, so prefer one targeted "
        f"search_files call over open-ended directory browsing when "
        f"you're looking for something specific. Produce the gap plan in "
        f"the exact format from Step 5 above. Your final response (no "
        f"further tool calls) must be exactly that plan text - the caller "
        f"writes it to {GAP_PLAN_FILE} itself, so do not call write_file "
        f"and do not add any chat header or commentary around the plan."
    )


def run_plan_narrow_step(ticket_content: str, model: str) -> str:
    """
    Merged plan+narrow: one model session, one artifact (the gap plan).
    See module-level comment above for why this doesn't also produce
    PLAN_FILE/.tdd-plan.md the way the two-step path does.
    """
    try:
        result = run_ai_step_with_retry(
            lambda: run_with_tools(
                build_plan_narrow_prompt(ticket_content),
                tools.READ_ONLY_TOOLS,
                tools.make_executor(allow_write=False, preloaded_paths={str(TICKET_FILE)}),
                "plan-narrow",
                model=model,
                summarize_call=tools.summarize_tool_call,
            ),
            "plan-narrow",
        )
    except (AIError, tools.PipelineAbort) as e:
        die_with_log("plan-narrow", str(e))
    if "## Acceptance Criteria" not in result.text:
        render_markdown(result.text)
        die_with_log("plan-narrow", "Planner-Narrower did not produce a valid gap plan (see output above).")
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
    the toolchain's evidence_subcommands, which deliberately excludes these; lint
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

    def attempt():
        test_files.clear()
        return run_with_tools(
            build_test_criterion_prompt(criterion, plan_text),
            tools.READ_WRITE_TOOLS,
            tools.make_executor(written_paths=test_files),
            "test-criterion",
            model=model,
            summarize_call=tools.summarize_tool_call,
        )

    try:
        result = run_ai_step_with_retry(attempt, "test-criterion", criterion=criterion)
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


def _extract_function_block(content: str, qualified_test_name: str) -> str | None:
    """
    Best-effort extraction of a test function's full source (signature
    through closing brace) by its short name (the last `::`-separated
    segment of qualified_test_name) - used to verify the test wasn't
    altered when it can't be fully protected from writes (see
    run_implement_for_criterion). Brace-counting only works for
    brace-delimited languages (Rust/TS/JS/C++/Java/Go/...); returns None
    for anything that doesn't match (e.g. Python), in which case the
    caller skips the check rather than false-failing on a language this
    can't parse.
    """
    short_name = qualified_test_name.rsplit("::", 1)[-1]
    match = re.search(rf"^[ \t]*.*\b{re.escape(short_name)}\s*\(", content, re.MULTILINE)
    if not match:
        return None
    brace_start = content.find("{", match.end())
    if brace_start == -1:
        return None
    depth = 0
    for i in range(brace_start, len(content)):
        if content[i] == "{":
            depth += 1
        elif content[i] == "}":
            depth -= 1
            if depth == 0:
                return content[match.start():i + 1]
    return None


def run_implement_for_criterion(
    criterion: str, plan_text: str, model: str, test_file: str, qualified_test_name: str
) -> list[str]:
    # protected_paths can't be used here the way it is for other steps:
    # when the test lives inline in the same file as the production code
    # it covers (e.g. Rust's #[cfg(test)] mod tests, the convention this
    # pipeline's own Tester prompt names as the default), test_file *is*
    # the file Implementor must edit to satisfy the criterion - blocking
    # writes to it entirely makes the task impossible, not safe. Instead,
    # snapshot the named test's own source before the run and verify
    # byte-for-byte afterward that it's unchanged, which protects against
    # tampering without blocking the surrounding edits Implementor
    # legitimately needs to make in the same file.
    original_content = Path(test_file).read_text(encoding="utf-8") if Path(test_file).is_file() else None
    original_block = (
        _extract_function_block(original_content, qualified_test_name)
        if original_content is not None else None
    )

    changed_files: list[str] = []

    def attempt():
        changed_files.clear()
        return run_with_tools(
            build_implement_criterion_prompt(criterion, plan_text, test_file),
            tools.READ_WRITE_TOOLS,
            tools.make_executor(written_paths=changed_files),
            "implement-criterion",
            model=model,
            summarize_call=tools.summarize_tool_call,
        )

    try:
        result = run_ai_step_with_retry(attempt, "implement-criterion", criterion=criterion)
    except (AIError, tools.PipelineAbort) as e:
        die_with_log("implement-criterion", str(e), criterion=criterion)
    if not changed_files:
        die_with_log(
            "implement-criterion", "Implementor finished without writing any files.", criterion=criterion
        )

    if original_block is not None and test_file in changed_files:
        new_content = Path(test_file).read_text(encoding="utf-8")
        new_block = _extract_function_block(new_content, qualified_test_name)
        if new_block is None:
            die_with_log(
                "implement-criterion",
                f"the named test {qualified_test_name} could not be found in "
                f"{test_file} after implementation - it may have been removed "
                f"or renamed, which isn't allowed.",
                criterion=criterion,
            )
        if new_block != original_block:
            die_with_log(
                "implement-criterion",
                f"the named test {qualified_test_name} in {test_file} was "
                f"modified during implementation, which isn't allowed - only "
                f"the surrounding production code may change.",
                criterion=criterion,
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

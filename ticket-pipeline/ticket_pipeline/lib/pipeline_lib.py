"""
pipeline_lib - shared step library for push_ticket.py and next_step.py
(the criteria-stack pipeline), plus the bench.py/bench_block.py
benchmark harness.

push_ticket.py seeds a `.criteria-stack.json` work-queue (fetch -> plan
-> narrow -> one CriterionFrame per remaining acceptance criterion).
next_step.py reads that stack and advances it one step at a time -
writing a test, pausing for a human to implement, detecting green
mechanically, or running the full ticket-validation gate (narrow again,
lint, full test suite, review) once a ticket's frames are exhausted.
Both scripts keep their own argparse setup and main() control flow;
everything else - prompt builders, the run_with_tools call shapes, the
stack's own I/O, the build/test command plumbing - lives here.

Functions named build_*_prompt() are pure string builders. Functions
named run_*_step()/run_*_gate() wrap a build_*_prompt() call with its
run_with_tools call, error handling (die() on AIError/PipelineAbort),
result validation, and console rendering - the same block every caller
of that step needs, so the only thing left at each CLI script's call
site is the step name and the variables it threads to the next step.

This module previously backed a wider set of scripts (check-ticket.py,
write-tests.py, resolve-ticket.py, implement-tests.py,
validate-and-review.py, tdd-pipeline.py) that implemented pieces of the
same fetch-plan-test-implement-review flow the criteria stack now owns
directly. Those scripts, and the functions that existed only to serve
them (the markdown "Test:" annotation mechanism, AI-driven
per-criterion implementation, the whole-plan non-per-criterion test/
implement/coverage steps, and the STALE_FILES/RESETTABLE_FILES generic
cleanup lists), are retired. A frozen copy of the old scripts and
prompts lives in the repo's legacy-pipeline/ directory for reference.
"""

import json
import logging
import os
import re
import shlex
import subprocess
import sys
import time
import tomllib
import urllib.error
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

from . import ai_client
from .ai_client import AIError, run_with_tools
from . import fetch_ticket as ticket_source
from .render import render_markdown
from . import repo_context
from . import tools
from . import toolchains
from . import verbosity

log = verbosity.get_logger(__name__)

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

SCRIPT_DIR = Path(__file__).resolve().parent
# Three levels up: this module lives in ticket-pipeline/ticket_pipeline/lib/,
# prompts/ is a repo-root sibling of ticket-pipeline/.
PROMPTS_DIR = SCRIPT_DIR.parent.parent.parent / "prompts"
TICKET_FILE = Path(".ticket.md")
PLAN_FILE = Path(".tdd-plan.md")
UPDATED_PLAN_FILE = Path(".updated-plan.md")
PIPELINE_CONFIG_FILE = Path(".dev-pipeline.toml")

# Transient scratch artifacts, not cross-invocation state: push_ticket
# writes these once to seed the stack, and next_step's TICKET_VALIDATE
# phase rewrites them fresh at validation time. .criteria-stack.json
# (CRITERIA_STACK_FILE, below) is the only file either script trusts
# across invocations - nothing here is read back by a later run the way
# the old STALE_FILES/RESETTABLE_FILES scripts relied on. Cleanup of
# these is push_ticket.py's own explicit responsibility (see its guard-
# then-cleanup ordering), not a shared generic list - a shared list
# serving callers with different lifecycles is exactly what caused a
# real ordering bug in an earlier draft of this pipeline (a cleanup step
# deleting the stack file before a re-entrancy guard could check it).
GAP_PLAN_FILE = Path(".gap-plan.md")
PIPELINE_LOG_FILE = Path(".pipeline-log.jsonl")

# The pipeline's canonical work-queue and sole cross-invocation source
# of truth - see CriterionFrame/load_stack/save_stack below.
CRITERIA_STACK_FILE = Path(".criteria-stack.json")

PLAN_PROMPT_FILE = PROMPTS_DIR / "plan.prompt.md"
NARROW_PROMPT_FILE = PROMPTS_DIR / "narrow-plan.prompt.md"
PLAN_NARROW_PROMPT_FILE = PROMPTS_DIR / "plan-narrow.prompt.md"
REVIEW_PROMPT_FILE = PROMPTS_DIR / "review-singlepass.prompt.md"
TEST_CRITERION_PROMPT_FILE = PROMPTS_DIR / "test-criterion.prompt.md"

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
# test_filter_cmd is used by next_step.py's per-criterion phases
# (run_scoped_test) - {filter} is substituted with the qualified test
# name recorded for that criterion's frame. Compiling can't be scoped to
# one test (a test binary compiles everything in it regardless of which
# test you'll filter at runtime), so there's no filtered equivalent of
# test_compile_cmd - only the run is ever scoped.
#
# fmt_fix_cmd/clippy_fix_cmd/fmt_check_cmd/clippy_cmd are used only by
# next_step.py's TICKET_VALIDATE phase (run_lint_gate) - lint/style
# checks run once, after every criterion in a ticket is implemented and
# passing, right before code review - not as acceptance-criteria
# evidence (see extract_plan_commands). Names
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


def extract_test_output_signal(output: str, pattern: str, context_lines: int = 15) -> str:
    """
    Filter a test run's raw stdout+stderr down to the lines a human
    actually needs to see why it's red, using the current toolchain's
    test_output_signal_pattern (see toolchains.py - built for exactly
    this, previously unused). Necessary because test_filter_cmd's
    default (e.g. cargo's "cargo test {filter}") isn't scoped to a
    single test binary - it's a name filter applied across every
    integration test file in the project, so the raw output is mostly
    "Running tests\\X.rs (...)" binary-listing noise for files that
    have nothing to do with the criterion at hand, with the actual
    panic/assertion detail buried or scrolled past entirely.

    Keeps each matching line plus up to `context_lines` following lines
    (a panic message's expected-vs-actual detail follows the "panicked
    at"/"---- test_name stdout ----" line that matches, not the line
    itself) and one line of leading context, collapsing gaps between
    kept ranges with a "..." separator so multiple failures in the same
    run all show, without the noise between them. Falls back to the
    full, untouched output if the pattern matches nothing - a test
    runner this heuristic doesn't fit should still show *something*
    rather than silently discarding real output.
    """
    if not output.strip():
        return output
    lines = output.splitlines()
    compiled = re.compile(pattern)
    keep: set[int] = set()
    for i, line in enumerate(lines):
        if compiled.search(line):
            keep.update(range(max(0, i - 1), min(len(lines), i + context_lines + 1)))
    if not keep:
        return output

    result_lines = []
    prev_idx = None
    for idx in sorted(keep):
        if prev_idx is not None and idx > prev_idx + 1:
            result_lines.append("...")
        result_lines.append(lines[idx])
        prev_idx = idx
    return "\n".join(result_lines)


# ---------------------------------------------------------------------------
# Generic helpers
# ---------------------------------------------------------------------------


def die(msg: str) -> None:
    log.error("error: %s", msg)
    log.error("-- Token usage so far: %s", ai_client.usage)
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


def remove_scratch_files(paths: tuple[Path, ...]) -> None:
    """
    push_ticket.py's own explicit cleanup step, called only after its
    re-entrancy/--force guard has already passed - see its module
    docstring for why this isn't a shared generic list run ahead of that
    guard the way the old STALE_FILES mechanism was.
    """
    for path in paths:
        if path.exists():
            path.unlink()
            log.info("-- Removed %s from a previous run", path)


# ---------------------------------------------------------------------------
# Diagnostic log - next_step.py only. Purely informational: "why did
# this fail last time" for a human reading the next invocation's output.
# Resumption decisions never consult this - phase detection always
# re-inspects real output state (the stack file, a scoped test run) for
# that, so a stale or missing log entry can't mislead the pipeline into
# the wrong resume point, only a human glancing at the wrong "last
# failure" note.
# ---------------------------------------------------------------------------


def log_event(
    block: str,
    status: str,
    error: str | None = None,
    criterion: str | None = None,
    ticket: str | None = None,
    tokens_prompt: int | None = None,
    tokens_completion: int | None = None,
    cost_usd: float | None = None,
) -> None:
    """
    tokens_prompt/tokens_completion/cost_usd are a *delta* attributable
    to this one event, not a running total - callers computing one use
    _usage_snapshot()/_usage_delta() (see below) around just the work
    this event reports on. None (not 0) for any event with no AI call
    behind it (a lint/build/test-suite gate failure, for instance) -
    0 would falsely claim "measured, cost nothing" for a block that was
    never priced at all.
    """
    entry = {
        "block": block,
        "ticket": ticket,
        "criterion": criterion,
        "ts": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "status": status,
        "error": error,
        "tokens_prompt": tokens_prompt,
        "tokens_completion": tokens_completion,
        "cost_usd": cost_usd,
    }
    with PIPELINE_LOG_FILE.open("a", encoding="utf-8") as f:
        f.write(json.dumps(entry) + "\n")


def die_with_log(
    block: str,
    msg: str,
    criterion: str | None = None,
    ticket: str | None = None,
    tokens_prompt: int | None = None,
    tokens_completion: int | None = None,
    cost_usd: float | None = None,
) -> None:
    """
    Like die(), but also records the failure to the diagnostic log first
    - used by every push_ticket.py/next_step.py failure path. Token
    fields are optional (see log_event) - most die_with_log call sites
    are gate failures (lint/build/test-suite) with no AI cost to report;
    a caller that does have a delta on hand (e.g. an AIError raised by a
    step this function wraps) should pass it through rather than losing
    it at the point of failure.
    """
    log_event(
        block, "failed", error=msg, criterion=criterion, ticket=ticket,
        tokens_prompt=tokens_prompt, tokens_completion=tokens_completion, cost_usd=cost_usd,
    )
    die(msg)


@dataclass
class _UsageSnapshot:
    """
    A point-in-time read of ai_client.usage's running totals - UsageTracker
    itself only exposes cumulative-since-process-start totals, not deltas,
    so a block wanting "what did just this call cost" snapshots before and
    after and subtracts. Safe because these totals only ever grow across a
    single-process run (see ai_client.UsageTracker) - never reset, never
    decrease - so a later-minus-earlier subtraction is exactly what was
    added in between, with no risk of going negative.
    """
    prompt_tokens: int
    completion_tokens: int
    cost_usd: float


def _usage_snapshot() -> _UsageSnapshot:
    cost, _unpriced = ai_client.usage.total_cost_usd()
    return _UsageSnapshot(ai_client.usage.prompt_tokens, ai_client.usage.completion_tokens, cost)


def _usage_delta(start: _UsageSnapshot) -> dict:
    """Returns a dict of tokens_prompt/tokens_completion/cost_usd kwargs
    ready to splat into log_event/die_with_log, covering everything
    ai_client.usage has accumulated since `start` was taken."""
    now = _usage_snapshot()
    return {
        "tokens_prompt": now.prompt_tokens - start.prompt_tokens,
        "tokens_completion": now.completion_tokens - start.completion_tokens,
        "cost_usd": round(now.cost_usd - start.cost_usd, 6),
    }


AI_STEP_MAX_ATTEMPTS = 3
AI_STEP_RETRY_BACKOFF_BASE_S = 5.0


def run_ai_step_with_retry(
    step_fn: Callable[[], object],
    label: str,
    criterion: str | None = None,
    ticket: str | None = None,
    max_attempts: int = AI_STEP_MAX_ATTEMPTS,
) -> object:
    """
    Calls step_fn() - a zero-arg closure performing one run_with_tools
    round trip and returning its parsed result - retrying only on
    AIError. tools.PipelineAbort (ask_user_prompt) propagates immediately,
    unretried: that's a deliberate model signal ("I need a human"), not a
    transient infra failure, and retrying changes nothing about a
    model's decision to ask for clarification. run_command is not a
    PipelineAbort - calling it returns a recoverable tool error to the
    model instead (see tools.py), so it never reaches this layer at all.

    Each retry calls step_fn() completely fresh (new message history
    inside run_with_tools); any written_paths/changed_files accumulator
    a caller threads into its closure must be cleared by step_fn itself
    at the top of each call, since a failed attempt's partial writes
    must not carry over into the next attempt's result.

    Every outcome is logged with its own token/cost delta (see
    _usage_snapshot/_usage_delta), not just failures - this is the data
    a later `.pipeline-log.jsonl` pass needs to compare models per
    block/ticket empirically instead of by feel:
      - "retry": one failed attempt's own delta, before sleeping with
        exponential backoff (matches ai_client's own transient-HTTP-retry
        backoff shape).
      - "success": step_fn() returned - the *cumulative* delta across
        every attempt this call made (including any that failed and were
        retried), so one block invocation nets exactly one success
        entry with its true total cost, not one entry per attempt.
      - "exhausted": every attempt failed and max_attempts is used up -
        same cumulative delta as "success" would have carried, logged
        here (not left for the call site) since only this function
        tracked it across every attempt. This helper still never itself
        decides to die - it logs, then re-raises the last AIError
        untouched, same as before; the call site's existing
        except/die_with_log handling is unchanged.
    """
    attempt = 0
    call_start = _usage_snapshot()
    while True:
        attempt += 1
        attempt_start = _usage_snapshot()
        try:
            result = step_fn()
        except ai_client.StepBudgetExceeded:
            raise
        except AIError as e:
            if attempt >= max_attempts:
                log_event(
                    label, "exhausted", error=str(e), criterion=criterion, ticket=ticket,
                    **_usage_delta(call_start),
                )
                raise
            log_event(
                label, "retry", error=str(e), criterion=criterion, ticket=ticket,
                **_usage_delta(attempt_start),
            )
            backoff_s = AI_STEP_RETRY_BACKOFF_BASE_S * (2 ** (attempt - 1))
            log.warning(
                "-- %s: attempt %d/%d failed (%s), retrying in %.0fs ...",
                label, attempt, max_attempts, e, backoff_s,
            )
            time.sleep(backoff_s)
            continue
        log_event(label, "success", criterion=criterion, ticket=ticket, **_usage_delta(call_start))
        return result


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
    log.warning("-- Note: last attempt failed at %s: %s", where, last.get("error"))


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
            log.info("-- %s: already satisfied, skipping", block.name)
            continue
        log.info("-- %s: running ...", block.name)
        block.run()
        if not block.check():
            die_with_log(block.name, f"{block.name} ran but its postcondition still isn't satisfied.")


def build_planning_blocks(ticket_id: str, model: str, ticket_file_in: Path | None = None) -> list[Block]:
    """
    The fetch -> plan -> narrow Block list used by push_ticket.py to seed
    the stack, and by next_step.py's TICKET_VALIDATE phase to re-fetch
    and re-plan before its safety-net re-narrow. Re-entrant: each block
    is skipped if its file already exists and passes its validity check,
    so calling this against a ticket that already has a valid
    .gap-plan.md from an earlier run does nothing here.

    ticket_file_in: if given, the fetch_ticket block reads this local
    file instead of calling Linear - e.g. a proposed revision from
    propose-ticket-edit.py that hasn't been pushed to Linear yet. Either
    way the content still gets written to TICKET_FILE (.ticket.md) -
    that's still this pipeline's one canonical ticket-state file; this
    only changes where its content originally comes from.
    """
    def fetch_ticket_content() -> str:
        if ticket_file_in is not None:
            if not ticket_file_in.is_file():
                die(f"--ticket-file-in {ticket_file_in} not found.")
            return ticket_file_in.read_text(encoding="utf-8")
        return fetch_ticket_text(ticket_id)

    return [
        Block(
            name="fetch_ticket",
            check=lambda: TICKET_FILE.is_file() and bool(TICKET_FILE.read_text(encoding="utf-8").strip()),
            run=lambda: tools.write_file_block(str(TICKET_FILE))(fetch_ticket_content()),
        ),
        Block(
            name="planner",
            check=lambda: PLAN_FILE.is_file() and "## Acceptance Criteria" in PLAN_FILE.read_text(encoding="utf-8"),
            run=lambda: run_plan_step(TICKET_FILE.read_text(encoding="utf-8"), model, ticket_id=ticket_id),
        ),
        Block(
            name="narrower",
            check=lambda: GAP_PLAN_FILE.is_file() and "## Acceptance Criteria" in GAP_PLAN_FILE.read_text(encoding="utf-8"),
            run=lambda: run_narrow_step(
                TICKET_FILE.read_text(encoding="utf-8"),
                PLAN_FILE.read_text(encoding="utf-8"),
                model,
                ticket_id=ticket_id,
            ),
        ),
    ]


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
        log.info(
            "-- Detected toolchain: %s. No %s found, using its defaults: %s",
            toolchain.name, config_path, commands,
        )
        return commands

    log.info("-- Detected toolchain: %s. Loading overrides from %s ...", toolchain.name, config_path)
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


def render_step_output(text: str, level: int = logging.DEBUG) -> None:
    """
    Renders a model step's raw markdown output (a plan, gap plan, or
    review verdict), gated by the current log level instead of always
    printing. This is the model's intermediate working output, not a
    script's actual result - the CLI scripts now report that separately
    via render.print_line, unconditionally - so it's hidden by default
    and only shown when --log-level asks for debug or below.
    """
    if log.isEnabledFor(level):
        render_markdown(text)


def run_command(command_str: str, label: str, quiet: bool = False) -> subprocess.CompletedProcess:
    """
    Commands come from the project-local pipeline config, which is
    user-authored and trusted (unlike ticket-derived text) - shlex-split
    and run as an argv list, never shell=True, simply because there's no
    reason to invoke a shell for a fixed toolchain command.

    Output logs at DEBUG on success and ERROR on failure - a passing
    `cargo test`/`clippy` run can be hundreds of lines that add nothing
    once the gate it's feeding into already passed; a failing one is
    exactly the output whoever's watching needs to diagnose it. Visible
    at the default `info` level only on failure, same as before; `debug`
    and below also show it on success.

    quiet=True always logs at DEBUG regardless of returncode - for a
    call where a nonzero exit is the *expected*, not exceptional, result
    (a red-test check) and the caller is about to present a filtered
    version of this same output itself (see next_step.py's
    do_await_impl/lib.extract_test_output_signal) - logging the raw dump
    at ERROR there would just be the same content twice, once as noise.
    """
    command_tokens = shlex.split(command_str)
    log.info("-- Running '%s' (%s) ...", command_str, label)
    result = subprocess.run(command_tokens, capture_output=True, text=True, check=False)
    log_fn = log.debug if quiet or result.returncode == 0 else log.error
    if result.stdout:
        log_fn(result.stdout)
    if result.stderr:
        log_fn(result.stderr)
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
    log.info("-- Fetching ticket %s ...", ticket_id)
    try:
        data = ticket_source.fetch_ticket(ticket_id)
    except urllib.error.HTTPError as e:
        die(f"Ticket fetch failed: HTTP {e.code}: {e.read().decode()}")
    return ticket_source.render(data)


# A ticket naming a real source file almost always does so backtick-
# quoted, either as a full path (`libs/virtual_assistant_api/src/
# stripe_webhook.rs`) or, when referring to something the ticket treats
# as already-familiar (e.g. "follows the existing stripe_webhook.rs
# pattern"), just the bare filename. Both are deliberately conservative
# (dotted extension required) so they don't match stray code
# identifiers or prose.
REFERENCED_PATH_RE = re.compile(r"`([\w./-]+/[\w.-]+\.[A-Za-z]{1,5})`")
REFERENCED_FILENAME_RE = re.compile(r"`([\w-]+\.[A-Za-z]{1,5})`")

# Directories never worth rglob-searching for a bare filename match -
# build output and dependency trees are huge and never what a ticket
# means by a short filename like "lib.rs".
_PREFETCH_SEARCH_PRUNE = {".git", "target", "node_modules", "dist", "build", ".venv"}

# Caps keep a pathological ticket (lots of backtick-quoted paths, or one
# huge file) from blowing up the prompt - this is meant to save the
# model a handful of read_file turns on the files it's overwhelmingly
# likely to want, not to front-load the whole repo.
PREFETCH_MAX_FILES = 12
PREFETCH_MAX_CHARS_PER_FILE = 8_000


def _resolve_bare_filename(name: str) -> str | None:
    """
    Bare filenames (no directory) have to be searched for - returns the
    repo-relative path if exactly one file with this name exists under
    cwd, None if zero or more than one (ambiguous; guessing wrong is
    worse than not prefetching at all).
    """
    matches = []
    for root, dirs, files in os.walk("."):
        dirs[:] = [d for d in dirs if d not in _PREFETCH_SEARCH_PRUNE and not d.startswith(".")]
        if name in files:
            matches.append(str(Path(root, name)).removeprefix(".\\").removeprefix("./"))
            if len(matches) > 1:
                return None
    return matches[0] if len(matches) == 1 else None


def extract_referenced_paths(text: str) -> list[str]:
    """
    Pulls candidate file paths out of `text` (a ticket body) - full
    paths via REFERENCED_PATH_RE kept as-is, bare filenames via
    REFERENCED_FILENAME_RE resolved against the repo tree - then keeps
    only the ones that actually exist as files (a ticket mentioning a
    path that doesn't exist, e.g. a file it wants created, is exactly
    the kind of false positive this filters out). Order-preserving,
    deduped.
    """
    seen: set[str] = set()
    paths: list[str] = []
    for match in REFERENCED_PATH_RE.finditer(text):
        candidate = match.group(1)
        if candidate in seen:
            continue
        seen.add(candidate)
        if Path(candidate).is_file():
            paths.append(candidate)
    for match in REFERENCED_FILENAME_RE.finditer(text):
        name = match.group(1)
        if name in seen:
            continue
        seen.add(name)
        resolved = _resolve_bare_filename(name)
        if resolved and resolved not in paths:
            paths.append(resolved)
    return paths


def prefetch_referenced_files(text: str, max_files: int = PREFETCH_MAX_FILES) -> tuple[str, set[str]]:
    """
    Reads the first `max_files` real files referenced by backtick-quoted
    paths in `text` and renders them as a prompt block, so a model
    reviewing/planning against the ticket starts with the files it's
    overwhelmingly likely to ask for already in context - saving the
    read_file turns (and the variance in whether/when a weaker model
    gets around to asking) the same way build_plan_prompt's ticket/
    repo-context embedding does.

    Returns (block, paths) - paths is meant for make_executor's
    preloaded_paths, so a model that still calls read_file on one of
    these gets the short dedup note instead of paying for the content
    twice. block is "" (and paths empty) if nothing was found, so
    callers can unconditionally interpolate it without an empty-block
    check at each call site.
    """
    paths = extract_referenced_paths(text)[:max_files]
    if not paths:
        return "", set()

    sections = []
    for path in paths:
        try:
            content = Path(path).read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        if len(content) > PREFETCH_MAX_CHARS_PER_FILE:
            content = content[:PREFETCH_MAX_CHARS_PER_FILE] + "\n... (truncated - read_file for the rest)"
        sections.append(f"### {path}\n```\n{content}\n```")

    if not sections:
        return "", set()

    block = (
        "Here are files the ticket references by path, prefetched so you "
        "don't need to read_file them again unless you need a part that "
        "was truncated below:\n\n" + "\n\n".join(sections)
    )
    return block, set(paths)


# ---------------------------------------------------------------------------
# Plan step
# ---------------------------------------------------------------------------


def build_plan_prompt(ticket_content: str) -> str:
    """
    Embeds the ticket content and a repo-context block directly, rather
    than making the model spend tool-call turns fetching things we
    already know with certainty it's going to want - the planner always
    needs the ticket, and orientation (toolchain, layout, module
    boundaries - see repo_context.py) is cheap to give upfront. Content
    embedded in the prompt is processed identically to content returned
    from a tool call (it's all just tokens in context), so this loses
    nothing - it just removes the variance of whether/when the model
    gets around to asking for it.
    """
    instructions = load_prompt_body(PLAN_PROMPT_FILE)
    repo_context_block = repo_context.render_repo_context_block(repo_context.gather_repo_context())
    return (
        f"{instructions}\n\n---\n\n"
        f"{AUTO_PREAMBLE}"
        f"Here is the ticket ({TICKET_FILE}) - already complete and "
        f"current, no need to read_file it again:\n\n{ticket_content}\n\n"
        f"Here is repo orientation context - already current, no need to "
        f"list_dir('.') again for the top-level layout:\n{repo_context_block}\n\n"
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


def run_plan_step(ticket_content: str, model: str, ticket_id: str | None = None) -> str:
    """
    Runs the plan step end to end: prompt, run_with_tools, validity
    check, write to disk, render. Returns plan_text for the caller to
    thread into whichever step comes next. ticket_id is passed straight
    through to run_ai_step_with_retry purely for its log_event calls -
    it's not needed for the prompt or the step itself, only so
    .pipeline-log.jsonl entries for this block can be attributed to the
    right ticket.
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
            ticket=ticket_id,
        )
    except (AIError, tools.PipelineAbort) as e:
        die(str(e))
    if "## Acceptance Criteria" not in result.text:
        render_step_output(result.text)
        die("Planner did not produce a valid plan (see output above).")
    log.info("-- Plan generated, writing to disk ...")
    plan_content = tools.write_file_block(str(PLAN_FILE))(result.text)
    render_step_output(plan_content)
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
# Narrow step - same evidence-gathering a coverage validator would need,
# but the output is plan-shaped (like the plan step's own output)
# instead of a prose verdict. push_ticket.py counts the remaining
# '## Acceptance Criteria' bullets to build the initial stack;
# next_step.py's TICKET_VALIDATE phase re-runs this fresh as a safety
# net after a ticket's frames are exhausted. Always writes to
# GAP_PLAN_FILE - transient scratch, not cross-invocation state (see the
# module-level comment above GAP_PLAN_FILE's definition).
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


def run_narrow_step(ticket_content: str, plan_content: str, model: str, ticket_id: str | None = None) -> str:
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
            ticket=ticket_id,
        )
    except (AIError, tools.PipelineAbort) as e:
        die_with_log("narrow", str(e), ticket=ticket_id)
    if "## Acceptance Criteria" not in result.text:
        render_step_output(result.text)
        die_with_log("narrow", "Narrower did not produce a valid gap plan (see output above).", ticket=ticket_id)
    log.info("-- Gap plan generated, writing to disk ...")
    gap_plan_content = tools.write_file_block(str(GAP_PLAN_FILE))(result.text)
    render_step_output(gap_plan_content)
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
    repo_context_block = repo_context.render_repo_context_block(repo_context.gather_repo_context())
    ticket_evidence_seed_block = repo_context.render_ticket_evidence_seed_block(
        repo_context.gather_ticket_evidence_seed(ticket_content)
    )
    return (
        f"{instructions}\n\n---\n\n"
        f"{AUTO_PREAMBLE}"
        f"Here is the ticket ({TICKET_FILE}) - already complete and "
        f"current, no need to read_file it again:\n\n{ticket_content}\n\n"
        f"Here is repo orientation context - already current, no need to "
        f"list_dir('.') again for the top-level layout:\n{repo_context_block}\n\n"
        f"Here is a ticket-aware evidence seed - preliminary host-side "
        f"search results for likely identifiers from the ticket. Use it "
        f"to orient faster, but do not treat it as proof by itself; you "
        f"still need to verify each criterion before marking it PASS:\n"
        f"{ticket_evidence_seed_block}\n\n"
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


def run_plan_narrow_step(ticket_content: str, model: str, ticket_id: str | None = None) -> str:
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
            ticket=ticket_id,
        )
    except (AIError, tools.PipelineAbort) as e:
        die_with_log("plan-narrow", str(e), ticket=ticket_id)
    if "## Acceptance Criteria" not in result.text:
        render_step_output(result.text)
        die_with_log(
            "plan-narrow", "Planner-Narrower did not produce a valid gap plan (see output above).",
            ticket=ticket_id,
        )
    log.info("-- Gap plan generated, writing to disk ...")
    gap_plan_content = tools.write_file_block(str(GAP_PLAN_FILE))(result.text)
    render_step_output(gap_plan_content)
    return gap_plan_content


# ---------------------------------------------------------------------------
# Per-criterion parsing (push_ticket.py) and scoped test execution
# (next_step.py). The old markdown "Test: <file> :: <name>" annotation
# mechanism that used to record a criterion's test pointer directly on
# .gap-plan.md is retired - CriterionFrame.test_file/test_name (see the
# stack section below) is the same information, stored as real
# structured state on the stack instead of a text annotation on a
# scratch file.
# ---------------------------------------------------------------------------


def extract_acceptance_criteria(plan_content: str) -> list[str]:
    """
    Pull each '- [ ] ...' line directly under '## Acceptance Criteria' -
    same list-tolerant parsing style as extract_plan_files, applied to
    the criteria section instead of the implementation section. Returns
    the exact bullet line text (including any trailing HTML comment) -
    push_ticket.py uses this verbatim text as a new CriterionFrame's
    `criterion` field.
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


# ---------------------------------------------------------------------------
# Criteria stack - .criteria-stack.json is the pipeline's canonical
# work-queue and the only file either push_ticket.py or next_step.py
# trusts across invocations. See the module docstring for how this
# replaces the old per-script state files.
# ---------------------------------------------------------------------------


@dataclass
class CriterionFrame:
    ticket: str           # e.g. "SA-42"
    criterion: str         # verbatim bullet from the gap plan, e.g. "- [ ] ..."
    plan_context: str      # Implementation Plan lines relevant to this
                            # criterion, extracted at push time (see
                            # extract_plan_context_for_criterion)
    test_file: str | None       # set once the test-writer runs
    test_name: str | None       # fully-qualified, for run_scoped_test
    status: str            # "pending" | "test-written" | "done"
    origin: str             # "ticket" | "review" | "validate-missed" -
                            # recorded but not yet acted on differently;
                            # all origins go through the identical
                            # test-write -> implement -> gate cycle.


def load_stack() -> list[CriterionFrame]:
    """
    Read .criteria-stack.json. Returns [] if the file does not exist or
    is empty. A corrupt or schema-mismatched file is a hard stop
    (die_with_log), not something to silently reset - the stack is the
    pipeline's only cross-invocation state, so guessing at a recovery
    would risk silently discarding in-progress work.
    """
    if not CRITERIA_STACK_FILE.is_file():
        return []
    text = CRITERIA_STACK_FILE.read_text(encoding="utf-8").strip()
    if not text:
        return []
    try:
        raw = json.loads(text)
    except json.JSONDecodeError as e:
        die_with_log("stack", f"{CRITERIA_STACK_FILE} is not valid JSON: {e}")
    try:
        return [CriterionFrame(**entry) for entry in raw]
    except TypeError as e:
        die_with_log("stack", f"{CRITERIA_STACK_FILE} does not match the expected frame schema: {e}")


def save_stack(frames: list[CriterionFrame]) -> None:
    """
    Serialise and write atomically: write to a temp file in the same
    directory, then os.replace. Prevents a partial write from
    corrupting the stack if the process is interrupted mid-write.
    """
    tmp_path = CRITERIA_STACK_FILE.with_name(CRITERIA_STACK_FILE.name + ".tmp")
    tmp_path.write_text(
        json.dumps([asdict(frame) for frame in frames], indent=2) + "\n", encoding="utf-8"
    )
    os.replace(tmp_path, CRITERIA_STACK_FILE)


def push_frames(frames: list[CriterionFrame]) -> None:
    """
    Prepend frames to the front of the existing stack and save. Used
    only by next_step.py, for review findings and validate-missed
    criteria - both prepend onto a stack that may already have content
    (the ticket's remaining frames, or none). push_ticket.py does NOT
    use this - it owns full-stack replacement directly via save_stack,
    since it only ever runs once its own guard confirms there's nothing
    worth preserving (see push_ticket.py's module docstring).
    """
    save_stack(frames + load_stack())


def pop_frame() -> CriterionFrame | None:
    """Remove and return frame 0, saving the updated stack to disk
    first. Returns None if the stack is empty."""
    stack = load_stack()
    if not stack:
        return None
    frame = stack.pop(0)
    save_stack(stack)
    return frame


def peek_frame() -> CriterionFrame | None:
    """Return frame 0 without modifying the stack. None if empty."""
    stack = load_stack()
    return stack[0] if stack else None


# A ticket's per-criterion frames are all real acceptance criteria with
# a test to write; this sentinel is not one - it's a durable stand-in
# for "TICKET_VALIDATE still needs to run/re-run for this ticket",
# recognized specially by next_step.py's phase detection rather than
# flowing through WRITE_TEST/AWAIT_IMPL/POP. Shared here (not private to
# next_step.py) because push_ticket.py's --validate-only pushes the same
# sentinel directly, without a pop ever having happened first.
VALIDATING_STATUS = "validating"
VALIDATING_ORIGIN = "ticket-validate"
VALIDATING_CRITERION_TEXT = "(ticket validation pending)"


def ensure_validating_sentinel(ticket_id: str) -> None:
    """
    Makes "this ticket still needs TICKET_VALIDATE" a durable stack
    frame instead of a fact that only exists for the duration of one
    call. Two callers:
      - next_step.py's do_ticket_validate, as the first thing it does,
        before any fallible step (fetch, plan, narrow, lint, test suite,
        smoke, review) - so if any of those dies, this sentinel is
        already safely on disk, and the next `next_step` invocation's
        phase detection finds it and retries validation from scratch
        instead of reporting "no work remaining" or moving on to a
        different ticket with no way back to this one.
      - push_ticket.py's --validate-only, to trigger a validation pass
        on demand for a ticket with no criteria currently on the stack
        (e.g. you believe it's already fully implemented and just want
        lint/test-suite/smoke/review to run) - same sentinel, same
        resume mechanism, just pushed directly instead of arrived at
        via a pop.

    Idempotent: does nothing if this exact sentinel is already the top
    frame - the case where this is a resumed retry after a prior
    validation failure, not a fresh one.
    """
    top = peek_frame()
    if top is not None and top.ticket == ticket_id and top.status == VALIDATING_STATUS:
        return
    push_frames([CriterionFrame(
        ticket=ticket_id,
        criterion=VALIDATING_CRITERION_TEXT,
        plan_context="",
        test_file=None,
        test_name=None,
        status=VALIDATING_STATUS,
        origin=VALIDATING_ORIGIN,
    )])


def extract_plan_context_for_criterion(criterion: str, gap_plan_text: str) -> str:
    """
    Extract the Implementation Plan entries relevant to `criterion`, for
    a CriterionFrame's plan_context field. Heuristic: lines from
    '## Implementation Plan' that mention any backtick-quoted token from
    the criterion's own text (file paths, type names, function names -
    the same convention the plan/gap-plan prompts use throughout).
    Falls back to the full Implementation Plan section if the criterion
    has no backtick tokens, or none of them match any line; falls back
    to the entire gap plan text if there's no Implementation Plan
    section at all. Never returns an empty string - the tester needs
    something to work from either way.
    """
    match = re.search(
        r"^## Implementation Plan\s*\n(.*?)(?:\n## |\Z)",
        gap_plan_text,
        re.DOTALL | re.MULTILINE,
    )
    if not match:
        return gap_plan_text
    impl_section = match.group(1).strip()
    if not impl_section:
        return gap_plan_text

    nouns = {tok.strip() for tok in BACKTICK_TOKEN_RE.findall(criterion) if tok.strip()}
    if not nouns:
        return impl_section

    matching_lines = [
        line for line in impl_section.splitlines()
        if any(noun in line for noun in nouns)
    ]
    return "\n".join(matching_lines) if matching_lines else impl_section


FINDINGS_SECTION_RE = re.compile(r"^## Findings\s*\n(.*?)(?:\n## |\Z)", re.DOTALL | re.MULTILINE)
FINDING_BULLET_TEXT_RE = re.compile(r"^[-*]\s*(?:\[[ xX]?\]\s*)?(.+)$")
FALLBACK_FINDING_RE = re.compile(r"^-\s*\*\*(.+?)\*\*:\s*(.+)$", re.MULTILINE)


def extract_review_findings(review_text: str) -> list[str]:
    """
    Parse a CHANGES REQUESTED review into a list of finding strings, one
    per actionable bullet - mechanical text extraction only, no AI call.

    Primary path: a '## Findings' section (see the Final Answer format
    added to review-singlepass.prompt.md) with one '- [ ] ...' bullet
    per finding. Fallback, for review output that predates or otherwise
    doesn't produce that section: '- **Category**: description' bullets,
    the shape review-singlepass.prompt.md's Step 3 has always produced
    for its findings list.

    Returns [] if neither shape is found - the caller (next_step.py)
    must die_with_log on an empty result rather than silently pushing
    zero frames for a CHANGES REQUESTED verdict.
    """
    match = FINDINGS_SECTION_RE.search(review_text)
    if match:
        findings = []
        for line in match.group(1).splitlines():
            line = line.strip()
            if not LIST_MARKER_RE.match(line):
                continue
            bullet_match = FINDING_BULLET_TEXT_RE.match(line)
            if bullet_match:
                findings.append(bullet_match.group(1).strip())
        if findings:
            return findings

    return [
        f"{category.strip()}: {description.strip()}"
        for category, description in FALLBACK_FINDING_RE.findall(review_text)
    ]


def run_scoped_test(
    qualified_test_name: str, commands: dict, label: str, quiet: bool = False
) -> subprocess.CompletedProcess:
    command_str = commands["test_filter_cmd"].format(filter=qualified_test_name)
    return run_command(command_str, label, quiet=quiet)


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
# next_step.py's TICKET_VALIDATE phase support - implementation here is
# manual (a human, not tool calls), so there's no automated agent
# tracking written_paths the way every other run_review_gate caller
# does, and an optional smoke-test gate no toolchain default should have
# to define.
# ---------------------------------------------------------------------------


# This pipeline's own scaffolding (ticket/plan/gap-plan/log/stack) ends
# up as real filesystem changes too (write_file_block/save_stack write
# them like any other file) but is never itself "the implementation" -
# excluded from git_changed_files so TICKET_VALIDATE's review gate
# judges the human's actual work, not the artifacts this pipeline wrote
# along the way.
_SCAFFOLDING_PATHS = frozenset(
    str(p) for p in (
        TICKET_FILE, PLAN_FILE, UPDATED_PLAN_FILE, GAP_PLAN_FILE,
        PIPELINE_LOG_FILE, CRITERIA_STACK_FILE,
    )
)


def git_changed_files() -> list[str]:
    """
    The only source of truth for "what did the human touch" when there's
    no automated agent tracking writes: tracked changes against HEAD
    (staged or not) plus new untracked files, deduped, minus this
    pipeline's own scaffolding files (see _SCAFFOLDING_PATHS). Trusted
    host tooling, not ticket-derived input - run as an argv list same as
    run_command, no shell.
    """
    tracked = subprocess.run(
        ["git", "diff", "--name-only", "HEAD"], capture_output=True, text=True, check=False
    )
    untracked = subprocess.run(
        ["git", "ls-files", "--others", "--exclude-standard"], capture_output=True, text=True, check=False
    )
    files = tracked.stdout.splitlines() + untracked.stdout.splitlines()
    seen: set[str] = set()
    deduped = []
    for f in files:
        f = f.strip()
        if f and f not in seen and f not in _SCAFFOLDING_PATHS:
            seen.add(f)
            deduped.append(f)
    return deduped


def load_smoke_cmd(config_path: Path) -> str | None:
    """
    Peeks for an optional 'smoke_cmd' key in the project-local pipeline
    config, outside load_pipeline_config's strict per-toolchain schema -
    no toolchain defines a smoke command (see toolchains.py), and none
    should have to just to support an optional gate. Returns None if the
    config file doesn't exist or doesn't set this key.
    """
    if not config_path.exists():
        return None
    with config_path.open("rb") as f:
        data = tomllib.load(f)
    value = data.get("smoke_cmd")
    return value if isinstance(value, str) and value.strip() else None


def run_smoke_gate(smoke_cmd: str | None) -> None:
    """
    Stub: no real process-lifecycle smoke testing yet (starting a
    server, probing a health endpoint, tearing it down is qualitatively
    different work than a single command's exit code). Skips cleanly if
    unset; if a project does set smoke_cmd, runs and gates on it the
    same shape as every other gate in this module.
    """
    if smoke_cmd is None:
        log.info("-- Smoke test: skipped (no smoke_cmd configured)")
        return
    result = run_command(smoke_cmd, "smoke test")
    if result.returncode != 0:
        die_with_log("smoke", f"Smoke test failed (exit {result.returncode}). See output above.")


# ---------------------------------------------------------------------------
# Per-criterion test step, and the final review gate. run_test_for_criterion
# (and its compile-retry variant) are next_step.py's WRITE_TEST phase; there
# is no per-criterion implement step - next_step always pauses for a human
# to implement (see the module docstring). `plan_context` here is a frame's
# already-scoped Implementation Plan excerpt (see
# extract_plan_context_for_criterion below), not the full gap plan - the
# caller (push_ticket.py, at frame-build time) does the scoping once, so
# this layer doesn't need to strip anything out of a full plan itself.
# ---------------------------------------------------------------------------

TEST_WITNESS_RE = re.compile(r"TEST_WITNESS:\s*(.+?)\s*::\s*(.+)$", re.MULTILINE)


def build_test_criterion_prompt(criterion: str, plan_context: str) -> str:
    instructions = load_prompt_body(TEST_CRITERION_PROMPT_FILE)
    return (
        f"{instructions}\n\n---\n\n"
        f"Here is the relevant Implementation Plan context for this "
        f"criterion, extracted from the gap plan - already complete and "
        f"current, no need to read_file it again:\n\n{plan_context}\n\n"
        f"Write a failing test for exactly this one acceptance criterion, "
        f"and only this one:\n\n{criterion}"
    )


def run_test_for_criterion(
    criterion: str, plan_context: str, model: str, ticket_id: str | None = None
) -> tuple[str, str]:
    test_files: list[str] = []

    def attempt():
        test_files.clear()
        return run_with_tools(
            build_test_criterion_prompt(criterion, plan_context),
            tools.READ_WRITE_TOOLS,
            tools.make_executor(written_paths=test_files),
            "test-criterion",
            model=model,
            summarize_call=tools.summarize_tool_call,
        )

    try:
        result = run_ai_step_with_retry(attempt, "test-criterion", criterion=criterion, ticket=ticket_id)
    except (AIError, tools.PipelineAbort) as e:
        die_with_log("test-criterion", str(e), criterion=criterion, ticket=ticket_id)
    if not test_files:
        die_with_log(
            "test-criterion", "Tester finished without writing any test files.",
            criterion=criterion, ticket=ticket_id,
        )
    render_step_output(result.text)
    witness = TEST_WITNESS_RE.search(result.text)
    if not witness:
        die_with_log(
            "test-criterion",
            "Tester's final answer did not include a TEST_WITNESS line (see output above).",
            criterion=criterion, ticket=ticket_id,
        )
    return witness.group(1).strip(), witness.group(2).strip()


def build_test_criterion_fix_prompt(criterion: str, plan_context: str, file_path: str, error_output: str) -> str:
    instructions = load_prompt_body(TEST_CRITERION_PROMPT_FILE)
    return (
        f"{instructions}\n\n---\n\n"
        f"Here is the relevant Implementation Plan context for this "
        f"criterion, extracted from the gap plan - already complete and "
        f"current, no need to read_file it again:\n\n{plan_context}\n\n"
        f"You already wrote a failing test for exactly this one "
        f"acceptance criterion, and only this one:\n\n{criterion}\n\n"
        f"but the test suite does not compile. read_file {file_path} and "
        f"fix it with write_file so it compiles and still fails for the "
        f"right reason - missing or incorrect behaviour, not a syntax or "
        f"type error. Do not weaken, skip, or remove the test, and do not "
        f"implement the production behaviour it's testing for. The "
        f"criterion must remain covered exactly as before; only the "
        f"compile error should be fixed.\n\n"
        f"Compile error:\n\n```\n{error_output}\n```"
    )


def run_test_for_criterion_with_compile_retry(
    criterion: str,
    plan_context: str,
    model: str,
    commands: dict,
    max_attempts: int = 3,
    ticket_id: str | None = None,
) -> tuple[str, str, subprocess.CompletedProcess]:
    """
    Like run_test_for_criterion, but also gates the written test on
    compilation and, if it fails to compile, feeds the compile error
    back to the Tester for a fix attempt instead of dying immediately -
    up to max_attempts attempts *total* (the initial write plus every
    fix retry counts against the same budget, not on top of it). This
    explicitly trades the pipeline's normal fail-fast-on-compile-error
    behaviour for a bounded self-correction loop: if max_attempts is
    exhausted with the suite still not compiling, the caller gets back
    the last (still-failing) CompletedProcess to report and die on,
    rather than this function retrying forever. next_step.py's
    WRITE_TEST phase uses this variant, not the plain one above, so a
    flaky first compile doesn't immediately abort the whole run.
    """
    test_files: list[str] = []
    file_path: str | None = None
    test_name: str | None = None
    last_error: str | None = None
    compile_result: subprocess.CompletedProcess | None = None

    for attempt in range(1, max_attempts + 1):
        if attempt == 1:
            prompt = build_test_criterion_prompt(criterion, plan_context)
        else:
            log.warning(
                "-- Compile failed (attempt %d/%d). Feeding the compile error back to Tester to fix.",
                attempt - 1, max_attempts,
            )
            prompt = build_test_criterion_fix_prompt(criterion, plan_context, file_path, last_error)

        def attempt_step():
            test_files.clear()
            return run_with_tools(
                prompt,
                tools.READ_WRITE_TOOLS,
                tools.make_executor(written_paths=test_files),
                "test-criterion",
                model=model,
                summarize_call=tools.summarize_tool_call,
            )

        try:
            result = run_ai_step_with_retry(
                attempt_step, "test-criterion", criterion=criterion, ticket=ticket_id
            )
        except (AIError, tools.PipelineAbort) as e:
            die_with_log("test-criterion", str(e), criterion=criterion, ticket=ticket_id)
        if not test_files:
            die_with_log(
                "test-criterion", "Tester finished without writing any test files.",
                criterion=criterion, ticket=ticket_id,
            )
        render_step_output(result.text)
        witness = TEST_WITNESS_RE.search(result.text)
        if not witness:
            die_with_log(
                "test-criterion",
                "Tester's final answer did not include a TEST_WITNESS line (see output above).",
                criterion=criterion, ticket=ticket_id,
            )
        file_path, test_name = witness.group(1).strip(), witness.group(2).strip()

        compile_result = run_command(
            commands["test_compile_cmd"], f"test compile gate (attempt {attempt}/{max_attempts})"
        )
        if compile_result.returncode == 0:
            return file_path, test_name, compile_result

        last_error = (compile_result.stdout or "") + (compile_result.stderr or "")
        # No token/cost delta here deliberately: this event is about the
        # compile gate (a subprocess, zero AI cost of its own) failing,
        # not about the Tester call above it - that call already got its
        # own "success" event (with its real cost) from run_ai_step_with_retry
        # regardless of whether the test it wrote went on to compile.
        log_event(
            "test-criterion", "retry",
            error=f"compile failed (attempt {attempt}/{max_attempts})", criterion=criterion, ticket=ticket_id,
        )

    return file_path, test_name, compile_result


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


def run_review_gate(changed_files: list[str], plan_text: str, model: str, ticket_id: str | None = None) -> tuple[str, str]:
    """
    Returns (verdict, raw_review_text) for any recognized verdict,
    including APPROVED - next_step.py's TICKET_VALIDATE phase branches
    on the verdict itself (APPROVED -> done; CHANGES REQUESTED -> pass
    raw_review_text straight to extract_review_findings), rather than
    this function dying on a non-APPROVED result the way it used to when
    "review failed" and "review passed" were this function's only two
    outcomes. die_with_log still fires on a genuine tool/AI failure or an
    unparseable verdict - those aren't a normal CHANGES REQUESTED result
    for the caller to act on.

    Routed through run_ai_step_with_retry like every other AI-calling
    step here (this used to call run_with_tools directly, with no retry
    on a transient AIError and no token/cost accounting) - both for
    consistency and so a review's cost shows up in .pipeline-log.jsonl
    same as every other block's.
    """
    try:
        review_result = run_ai_step_with_retry(
            lambda: run_with_tools(
                build_review_prompt(changed_files, plan_text),
                tools.READ_ONLY_TOOLS,
                tools.make_executor(allow_write=False),
                "review",
                model=model,
                summarize_call=tools.summarize_tool_call,
            ),
            "review",
            ticket=ticket_id,
        )
    except (AIError, tools.PipelineAbort) as e:
        die_with_log("review", str(e), ticket=ticket_id)
    render_step_output(review_result.text)
    verdict = find_verdict(review_result.text, ["CHANGES REQUESTED", "APPROVED"])
    if verdict is None:
        die_with_log(
            "review", "Reviewer's output did not contain a recognizable verdict (see output above).",
            ticket=ticket_id,
        )
    return verdict, review_result.text

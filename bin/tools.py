"""
tools - local file read/write/list tool layer for model tool calls.

No MCP, no subprocess, no external server - these execute in-process
against the project's working directory (cwd), with the same
path-confinement guard regardless of which tool is called. Intended for
use with ai_client.run_with_tools, which expects an executor of the
shape produced by make_executor() below.
"""

import os
import re
from pathlib import Path


class ToolError(RuntimeError):
    """Raised for any tool-execution failure. Callers turn this into a
    string error result for the model, not a hard crash - a model that
    tries to read a nonexistent file should be told so and get to
    recover, not blow up the whole pipeline step."""


class PipelineAbort(RuntimeError):
    """
    Base class for pseudo-tool calls that are never turned into a string
    result fed back to the model - the call itself is the fail-fast
    signal. Left to propagate out of ai_client.run_with_tools to the
    caller, which catches this alongside AIError.
    """


class ClarificationNeeded(PipelineAbort):
    """
    Raised when the model calls the ask_user_prompt pseudo-tool. These
    pipelines are single-shot and non-interactive, so there is no human
    to actually answer mid-task - receiving the call is itself the
    fail-fast signal, with the model's question as the failure reason.
    """


class CommandExecutionRefused(PipelineAbort):
    """
    Raised when the model calls the run_command pseudo-tool. Running
    arbitrary model-chosen commands is a real capability we haven't
    decided how to bound yet (which commands, what cwd, what counts as
    safe) - until that's designed, any attempt is refused outright, with
    the attempted command as the failure reason rather than silently
    ignored or executed unsupervised.
    """


def _safe_path(path_str: str) -> Path:
    """
    Resolve `path_str` relative to cwd and refuse anything that would
    escape the project root - absolute paths or '..' traversal. This is
    model-generated input, untrusted in the same sense as any external
    input that ends up driving a filesystem write.
    """
    cwd = Path.cwd().resolve()
    path = Path(path_str)
    if path.is_absolute() or ".." in path.parts:
        raise ToolError(f"path escapes project root: {path_str}")
    resolved = (cwd / path).resolve()
    if resolved != cwd and cwd not in resolved.parents:
        raise ToolError(f"path escapes project root: {path_str}")
    return resolved


def read_file(path: str, start_line: int | None = None, end_line: int | None = None) -> str:
    """
    Read a file's content. With no range, returns the raw full text
    (unchanged behaviour). With start_line/end_line (1-indexed,
    inclusive; either may be omitted to mean "to the start"/"to the
    end"), returns just that slice with line numbers prefixed, so a
    model can page through a large file without spending its whole
    context budget on one read_file call. A negative start_line means
    "N lines from the end" (tail-style) - e.g. start_line=-20 returns the
    last 20 lines; end_line is ignored in that mode, since "last N to
    line X" isn't a request that comes up in practice.
    """
    resolved = _safe_path(path)
    if not resolved.is_file():
        raise ToolError(f"not found: {path}")
    text = resolved.read_text(encoding="utf-8", errors="replace")
    if start_line is None and end_line is None:
        return text

    lines = text.splitlines()
    total = len(lines)

    if start_line is not None and start_line < 0:
        start = max(1, total + start_line + 1)
        end = total
    else:
        start = start_line if start_line is not None else 1
        # Validate start against the file's actual bounds before
        # defaulting end_line to total - otherwise an out-of-range
        # start_line with no end_line produces a confusing "end_line
        # must be >= start_line" error instead of the real "start_line
        # is beyond end of file" one.
        if start < 1:
            raise ToolError(f"start_line must be >= 1, got {start}")
        if start > total:
            raise ToolError(f"start_line {start} is beyond end of file ({total} lines)")
        end = end_line if end_line is not None else total
        if end < start:
            raise ToolError(f"end_line ({end}) must be >= start_line ({start})")
        end = min(end, total)

    numbered = "\n".join(f"{i:>6}\t{lines[i - 1]}" for i in range(start, end + 1))
    return f"(showing lines {start}-{end} of {total} total)\n{numbered}"


# Directories that are almost never useful to search and can be huge
# (VCS internals, dependency trees, build output, caches) - pruned
# before os.walk descends into them, not just filtered after the fact.
SEARCH_IGNORED_DIR_NAMES = {
    ".git", ".hg", ".svn",
    "node_modules", "target", "dist", "build",
    "__pycache__", ".mypy_cache", ".pytest_cache", ".ruff_cache",
    ".venv", "venv",
}

DEFAULT_SEARCH_MAX_RESULTS = 200
HARD_SEARCH_MAX_RESULTS = 500


def search_files(
    pattern: str,
    path: str = ".",
    regex: bool = False,
    max_results: int = DEFAULT_SEARCH_MAX_RESULTS,
) -> str:
    """
    Recursively search file contents under `path` for `pattern`, like
    grep - plain substring match by default, or a regular expression if
    `regex` is True. Pure Python (re + os.walk), no subprocess and no
    shell, so it works identically regardless of platform or whether a
    real grep binary is installed. Binary files are skipped via a
    strict-UTF-8 decode check; common non-source directories are pruned
    before descending into them.
    """
    resolved = _safe_path(path)
    if not resolved.is_dir():
        raise ToolError(f"not a directory: {path}")

    if regex:
        try:
            compiled = re.compile(pattern)
        except re.error as e:
            raise ToolError(f"invalid regex: {e}")
        line_matches = compiled.search
    else:
        line_matches = lambda line: pattern in line  # noqa: E731

    max_results = max(1, min(max_results, HARD_SEARCH_MAX_RESULTS))
    cwd = Path.cwd().resolve()
    results: list[str] = []
    truncated = False

    for root, dirnames, filenames in os.walk(resolved):
        dirnames[:] = sorted(d for d in dirnames if d not in SEARCH_IGNORED_DIR_NAMES)
        for filename in sorted(filenames):
            file_path = Path(root) / filename
            try:
                text = file_path.read_text(encoding="utf-8", errors="strict")
            except (UnicodeDecodeError, OSError):
                continue
            rel = file_path.relative_to(cwd).as_posix()
            for line_number, line in enumerate(text.splitlines(), start=1):
                if line_matches(line):
                    results.append(f"{rel}:{line_number}:{line.strip()}")
                    if len(results) >= max_results:
                        truncated = True
                        break
            if truncated:
                break
        if truncated:
            break

    if not results:
        return f"(no matches for {pattern!r} under {path})"
    output = "\n".join(results)
    if truncated:
        output += f"\n(showing first {max_results} matches - narrow your pattern or path)"
    return output


def write_file(path: str, content: str) -> str:
    resolved = _safe_path(path)
    resolved.parent.mkdir(parents=True, exist_ok=True)
    resolved.write_text(content, encoding="utf-8")
    return f"wrote {path} ({len(content)} bytes)"


def list_dir(path: str = ".") -> str:
    resolved = _safe_path(path)
    if not resolved.is_dir():
        raise ToolError(f"not a directory: {path}")
    entries = sorted(
        p.name + ("/" if p.is_dir() else "") for p in resolved.iterdir()
    )
    return "\n".join(entries) if entries else "(empty)"


# ---------------------------------------------------------------------------
# OpenAI-style tool schemas
# ---------------------------------------------------------------------------

READ_FILE_SCHEMA = {
    "type": "function",
    "function": {
        "name": "read_file",
        "description": (
            "Read a file's content, path relative to the project root. "
            "With no start_line/end_line, returns the full current "
            "content. For a large file, pass start_line and/or end_line "
            "(1-indexed, inclusive) to read just that slice instead - "
            "the result comes back with line numbers prefixed. Pass a "
            "negative start_line for a tail-style read of the last N "
            "lines (e.g. start_line=-20 for the last 20 lines). Prefer a "
            "full read for files you're likely to need entirely; use a "
            "range when you only need to check or quote a specific part "
            "of something large."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "path": {"type": "string"},
                "start_line": {
                    "type": "integer",
                    "description": "First line to read, 1-indexed, inclusive. Omit to start from the beginning. Negative means 'N lines from the end' (tail-style); end_line is ignored in that case.",
                },
                "end_line": {
                    "type": "integer",
                    "description": "Last line to read, 1-indexed, inclusive. Omit to read to the end.",
                },
            },
            "required": ["path"],
        },
    },
}

LIST_DIR_SCHEMA = {
    "type": "function",
    "function": {
        "name": "list_dir",
        "description": "List entries in a directory, path relative to the project root. Defaults to the project root.",
        "parameters": {
            "type": "object",
            "properties": {"path": {"type": "string"}},
            "required": [],
        },
    },
}

SEARCH_FILES_SCHEMA = {
    "type": "function",
    "function": {
        "name": "search_files",
        "description": (
            "Search file contents recursively under a directory, like "
            "grep -rn. Plain substring match by default; pass regex=true "
            "for a regular expression instead. Common non-source "
            "directories (.git, node_modules, target, __pycache__, etc.) "
            "and binary files are skipped automatically. Results are "
            "capped (default 200, max 500 matching lines) - narrow your "
            "pattern or path if you hit the cap rather than relying on "
            "the cap to find everything."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "pattern": {"type": "string"},
                "path": {
                    "type": "string",
                    "description": "Directory to search under, relative to the project root. Defaults to the project root.",
                },
                "regex": {
                    "type": "boolean",
                    "description": "Treat pattern as a regular expression instead of a plain substring. Defaults to false.",
                },
                "max_results": {
                    "type": "integer",
                    "description": "Maximum matching lines to return (default 200, hard cap 500).",
                },
            },
            "required": ["pattern"],
        },
    },
}

WRITE_FILE_SCHEMA = {
    "type": "function",
    "function": {
        "name": "write_file",
        "description": (
            "Write (overwrite) a file's complete contents, path relative "
            "to the project root. Creates parent directories as needed. "
            "Always pass the full file content, never a diff or excerpt."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "path": {"type": "string"},
                "content": {"type": "string"},
            },
            "required": ["path", "content"],
        },
    },
}

ASK_USER_PROMPT_TOOL_NAME = "ask_user_prompt"

ASK_USER_PROMPT_SCHEMA = {
    "type": "function",
    "function": {
        "name": ASK_USER_PROMPT_TOOL_NAME,
        "description": (
            "Call this ONLY if you genuinely cannot proceed without human "
            "clarification - e.g. the plan or ticket is ambiguous in a way "
            "you cannot reasonably resolve from context, or required "
            "information is missing and not discoverable via read_file or "
            "list_dir. This pipeline is single-shot and non-interactive: "
            "calling this tool immediately aborts the entire run with your "
            "question as the failure reason. There is no human available to "
            "answer and no retry afterwards. Only call this as a last "
            "resort, after attempting to resolve the ambiguity yourself per "
            "your other instructions - do not call it speculatively or to "
            "confirm something you could reasonably infer."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "question": {
                    "type": "string",
                    "description": "The specific question blocking progress.",
                }
            },
            "required": ["question"],
        },
    },
}

RUN_COMMAND_TOOL_NAME = "run_command"

RUN_COMMAND_SCHEMA = {
    "type": "function",
    "function": {
        "name": RUN_COMMAND_TOOL_NAME,
        "description": (
            "Run a command-line command. NOT SUPPORTED: calling this tool "
            "immediately aborts the entire run with the attempted command "
            "as the failure reason - there is no shell behind this, ever. "
            "Build and test verification is handled by the caller between "
            "steps, not by you. For the common reasons models reach for a "
            "shell: use search_files instead of grep/find, use read_file's "
            "start_line/end_line (including a negative start_line for "
            "tail-style reads) instead of head/tail, and use list_dir "
            "instead of ls - none of these need cd first, every tool here "
            "takes an explicit path."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "command": {
                    "type": "string",
                    "description": "The command that would have been run.",
                }
            },
            "required": ["command"],
        },
    },
}

# Every step gets these alongside its other tools - ask_user_prompt gives
# the model an explicit way to signal "I'm stuck" instead of guessing,
# and run_command is offered but always refused (see CommandExecutionRefused)
# so a model that reaches for it gets a clear, structured failure instead
# of either silent unsupported-tool noise or actually executing something.
READ_ONLY_TOOLS = [
    READ_FILE_SCHEMA,
    LIST_DIR_SCHEMA,
    SEARCH_FILES_SCHEMA,
    ASK_USER_PROMPT_SCHEMA,
    RUN_COMMAND_SCHEMA,
]

READ_WRITE_TOOLS = [
    READ_FILE_SCHEMA,
    LIST_DIR_SCHEMA,
    SEARCH_FILES_SCHEMA,
    WRITE_FILE_SCHEMA,
    ASK_USER_PROMPT_SCHEMA,
    RUN_COMMAND_SCHEMA,
]


def make_executor(
    written_paths: list[str] | None = None,
    allow_write: bool = True,
    protected_paths: set[str] | None = None,
    preloaded_paths: set[str] | None = None,
):
    """
    Build a tool_executor(name, args) -> str for ai_client.run_with_tools.

    written_paths: if given, every successful write_file call appends its
        path here, so callers can track what was written without
        re-parsing model output text.
    allow_write: if False, write_file calls are rejected outright - a
        defense-in-depth backstop for read-only steps, independent of
        whether write_file is even in the tool schema offered to the
        model (schemas constrain what's offered; this constrains what's
        actually executed).
    protected_paths: write_file calls targeting any of these paths are
        rejected without writing - e.g. so an Implement step can't
        overwrite the test files it's supposed to be satisfying.
    preloaded_paths: paths whose content the caller already embedded
        directly in the initial prompt (e.g. the ticket), rather than
        making the model fetch them via read_file. Seeded as fully-read,
        so a redundant read_file call on one of these still gets the
        short dedup note instead of resending content the model was
        already given - including a partial-range read, since having
        the whole file already covers any slice of it.

    Every chat-completions turn resends the *entire* message history,
    tool results included - the API has no server-side session state.
    A model re-reading the same file at turn 3 and turn 6 doesn't just
    double that file's tokens once; it doubles them in every turn's
    payload from turn 6 onward for the rest of the conversation. To stop
    that, reads are cached per executor instance: a full read of a path
    already fully read gets a short note instead of the content again,
    and a partial range already read at that exact range does too. A
    *different* range on a path that's only been partially read is not
    deduped - the model genuinely doesn't have that part yet. write_file
    invalidates all cache state for its own path, since the content
    genuinely changed and a later read should see it.
    """
    full_read_paths: set[str] = set(preloaded_paths or ())
    partial_ranges: set[tuple[str, int | None, int | None]] = set()

    def executor(name: str, args: dict) -> str:
        if name == ASK_USER_PROMPT_TOOL_NAME:
            question = args.get("question", "(no question provided)")
            raise ClarificationNeeded(
                f"model requested human clarification mid-task: {question}"
            )
        if name == RUN_COMMAND_TOOL_NAME:
            command = args.get("command", "(no command provided)")
            raise CommandExecutionRefused(
                f"model attempted to run a command, which isn't supported "
                f"yet: {command}"
            )
        try:
            if name == "read_file":
                path = args["path"]
                start_line = args.get("start_line")
                end_line = args.get("end_line")
                range_key = (path, start_line, end_line)

                if path in full_read_paths or range_key in partial_ranges:
                    return (
                        f"(duplicate read_file(\"{path}\") - you already have "
                        f"this content (or the whole file, which covers it), "
                        f"either from the initial prompt or an earlier "
                        f"read_file call in this conversation; not re-sent to "
                        f"save context)"
                    )
                content = read_file(path, start_line, end_line)
                if start_line is None and end_line is None:
                    full_read_paths.add(path)
                else:
                    partial_ranges.add(range_key)
                return content
            if name == "list_dir":
                return list_dir(args.get("path", "."))
            if name == "search_files":
                return search_files(
                    args["pattern"],
                    args.get("path", "."),
                    args.get("regex", False),
                    args.get("max_results", DEFAULT_SEARCH_MAX_RESULTS),
                )
            if name == "write_file":
                if not allow_write:
                    return "ERROR: write_file is not available in this step"
                path = args["path"]
                if protected_paths and path in protected_paths:
                    return f"ERROR: refused to overwrite protected file: {path}"
                result = write_file(path, args["content"])
                full_read_paths.discard(path)
                partial_ranges.difference_update(
                    {key for key in partial_ranges if key[0] == path}
                )
                if written_paths is not None:
                    written_paths.append(path)
                return result
            return f"ERROR: unknown tool: {name}"
        except ToolError as e:
            return f"ERROR: {e}"
        except KeyError as e:
            return f"ERROR: missing required argument: {e}"

    return executor

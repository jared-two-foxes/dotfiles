"""
render - console markdown rendering for model output.

Model responses (plan summaries, validator/reviewer verdicts) are
markdown - headings, bold, tables, code blocks - written per the
prompts' own conventions. Printing that raw is readable but ugly;
this renders it properly via `rich`.

Wrapping stdout in a UTF-8 TextIOWrapper works around a real failure
mode on Windows: rich's legacy-console code path encodes through
whatever codepage the terminal is actually using (often cp1252, not
UTF-8), and the prompts' own "🤖" marker is enough to crash that path
with UnicodeEncodeError. If rendering still fails for any other reason,
fall back to a plain print rather than taking the whole pipeline down
over a presentation nicety.
"""

import io
import sys

from rich.console import Console
from rich.markdown import Markdown

_console = Console(
    file=io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
)


def render_markdown(text: str) -> None:
    try:
        _console.print(Markdown(text))
    except Exception:
        print(text)


def print_line(text: str = "") -> None:
    """
    Unconditional stdout output, independent of --log-level. Used for a
    script's actual result (final summary, success/failure line, token
    usage) - the thing the script exists to report, not a progress or
    diagnostic message that's fine to filter out at a quieter level.
    """
    print(text, flush=True)

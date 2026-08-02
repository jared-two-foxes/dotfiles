"""
Builds the initial prompt for the AgentPlanningStrategy agent session.

Public API
----------
extract_criteria_with_ids  — parse ticket text and assign stable AC-N IDs
build_agent_prompt         — render the full initial prompt string
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    pass

_PROMPT_TEMPLATE_PATH = Path(__file__).parent.parent / "prompts" / "agent-plan.prompt.md"

# Regex to strip YAML front-matter from the template
_FRONTMATTER_RE = re.compile(r"^---\n.*?\n---\n", re.DOTALL)


def extract_criteria_with_ids(ticket_content: str) -> list[tuple[str, str]]:
    """
    Extract acceptance criteria from ticket markdown and assign stable IDs.

    Each criterion is assigned a deterministic ``AC-N`` ID based on its
    position in the ticket.

    Returns
    -------
    list of (criterion_id, criterion_text) tuples.
    An empty list is returned when no acceptance criteria section is found.
    """
    try:
        from ..lib import pipeline_lib as lib  # type: ignore[import]

        raw_criteria = lib.extract_acceptance_criteria(ticket_content)
    except (ImportError, AttributeError):
        raw_criteria = _fallback_extract_criteria(ticket_content)

    return [(f"AC-{i + 1}", criterion) for i, criterion in enumerate(raw_criteria)]


def _fallback_extract_criteria(ticket_content: str) -> list[str]:
    """
    Simple fallback when pipeline_lib is unavailable.

    Extracts bullet-list items from an 'Acceptance Criteria' or
    'Definition of Done' section.
    """
    criteria: list[str] = []

    section_pattern = re.compile(
        r"##\s*(?:Acceptance Criteria|Definition of Done|AC|DoD)\s*\n(.*?)(?=\n##|\Z)",
        re.IGNORECASE | re.DOTALL,
    )
    section_match = section_pattern.search(ticket_content)
    if not section_match:
        return criteria

    section_text = section_match.group(1)
    for line in section_text.splitlines():
        stripped = line.strip()
        if stripped.startswith("- [ ]") or stripped.startswith("- [x]"):
            criterion = re.sub(r"^-\s*\[[ xX]\]\s*", "", stripped)
            criterion = re.sub(r"\s*<!--[\s\S]*?-->\s*$", "", criterion).strip()
            if criterion:
                criteria.append(criterion)
        elif stripped.startswith("- ") and not stripped.startswith("- ["):
            criterion = stripped[2:].strip()
            if criterion:
                criteria.append(criterion)

    return criteria


def _render_criteria_list(criteria_with_ids: list[tuple[str, str]]) -> str:
    """Render the criteria list for inclusion in the prompt."""
    if not criteria_with_ids:
        return "(No explicit acceptance criteria found — the agent may derive criteria but must mark each as derived.)"
    lines = [f"- **{cid}**: {text}" for cid, text in criteria_with_ids]
    return "\n".join(lines)


def _collect_toolchain_info(project_root: Path) -> str:
    """Return a brief summary of the repository toolchain."""
    hints: list[str] = []

    indicators = {
        "pyproject.toml": "Python (pyproject.toml)",
        "setup.py": "Python (setup.py)",
        "Cargo.toml": "Rust (Cargo)",
        "package.json": "Node.js (npm/yarn)",
        "go.mod": "Go",
        "build.gradle": "Java/Kotlin (Gradle)",
        "pom.xml": "Java (Maven)",
        "CMakeLists.txt": "C/C++ (CMake)",
        "Makefile": "Make",
    }
    for filename, description in indicators.items():
        if (project_root / filename).is_file():
            hints.append(description)

    if not hints:
        return "Toolchain: unknown (inspect the repository root for build files)."
    return "Toolchain: " + ", ".join(hints) + "."


def _prefetch_referenced_files(
    ticket_content: str,
    project_root: Path,
    *,
    max_files: int = 5,
    max_bytes: int = 8000,
) -> str:
    """
    Cheaply prefetch files explicitly referenced in the ticket.

    Returns a markdown block of file contents, or an empty string if none
    are found or readable.  Preloading is capped to avoid an excessively
    long prompt.
    """
    referenced: list[str] = []
    # Match backtick-quoted paths that look like file paths
    for match in re.finditer(r"`([^`]+\.[a-zA-Z0-9_]{1,10})`", ticket_content):
        candidate = match.group(1)
        if "/" in candidate or candidate.endswith(".py"):
            referenced.append(candidate)

    if not referenced:
        return ""

    seen: set[str] = set()
    blocks: list[str] = []
    total_bytes = 0

    for rel_path in referenced:
        if rel_path in seen or len(blocks) >= max_files:
            break
        seen.add(rel_path)
        target = project_root / rel_path
        if not target.is_file():
            continue
        try:
            content = target.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        if total_bytes + len(content) > max_bytes:
            content = content[: max(0, max_bytes - total_bytes)]
            content += "\n... (truncated)"
        total_bytes += len(content)
        blocks.append(f"### `{rel_path}`\n\n```\n{content}\n```")
        if total_bytes >= max_bytes:
            break

    if not blocks:
        return ""
    return "## Prefetched Referenced Files\n\n" + "\n\n".join(blocks)


def build_agent_prompt(
    *,
    ticket_content: str,
    criteria_with_ids: list[tuple[str, str]],
    project_root: Path,
    prompt_template_path: Path | None = None,
) -> str:
    """
    Render the full initial prompt for the planning agent.

    Parameters
    ----------
    ticket_content:
        Complete rendered ticket markdown.
    criteria_with_ids:
        List of (criterion_id, criterion_text) as produced by
        extract_criteria_with_ids().
    project_root:
        Absolute path to the repository root.
    prompt_template_path:
        Override for the template file path. Defaults to
        src/ticket_pipeline/prompts/agent-plan.prompt.md.

    Returns
    -------
    The rendered prompt string suitable for the LLM system/user message.
    """
    template_path = prompt_template_path or _PROMPT_TEMPLATE_PATH
    try:
        template = template_path.read_text(encoding="utf-8")
    except OSError as exc:
        raise RuntimeError(
            f"Cannot read agent prompt template at {template_path}: {exc}"
        ) from exc

    # Strip YAML front-matter
    template = _FRONTMATTER_RE.sub("", template).lstrip()

    criteria_list = _render_criteria_list(criteria_with_ids)
    toolchain_info = _collect_toolchain_info(project_root)
    prefetched = _prefetch_referenced_files(ticket_content, project_root)

    prompt = template
    prompt = prompt.replace("${TICKET_CONTENT}", ticket_content)
    prompt = prompt.replace("${CRITERIA_LIST}", criteria_list)
    prompt = prompt.replace("${PROJECT_ROOT}", str(project_root))
    prompt = prompt.replace("${TOOLCHAIN_INFO}", toolchain_info)
    prompt = prompt.replace("${PREFETCHED_FILES}", prefetched)

    return prompt

"""
Tool definitions for the AgentPlanningStrategy agent.

Exposes read-only repository exploration tools and terminal pseudo-tools.

Read-only tools (always available):
    read_file       — read the full contents of a file
    list_dir        — list a directory's entries
    search_files    — search for files by name or content pattern
    file_exists     — check whether a path exists

Terminal pseudo-tools (end the agent loop):
    submit_plan     — successful completion; deserialises, validates, and
                      returns an AgentPlanSubmission
    planning_failed — failure completion; raises PlanningError

Interactive pseudo-tool (non-terminal when input is available):
    ask_user_input  — request clarification for a material ambiguity

Forbidden tools (must never be exposed):
    write_file, edit_file, delete_file, run_command, apply_patch,
    git_commit, git_checkout
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import TYPE_CHECKING, Any, Callable

if TYPE_CHECKING:
    from .agent_models import AgentPlanSubmission

# ---------------------------------------------------------------------------
# Terminal-tool signals
# ---------------------------------------------------------------------------


class _SubmissionReceived(Exception):
    """Raised when the agent successfully calls submit_plan."""

    def __init__(self, submission: "AgentPlanSubmission") -> None:
        self.submission = submission
        super().__init__("Agent submitted plan.")


class _PlanningFailed(Exception):
    """Raised when the agent calls planning_failed."""

    VALID_CATEGORIES: frozenset[str] = frozenset(
        {
            "insufficient_ticket",
            "repository_unavailable",
            "unsupported_repository",
            "conflicting_requirements",
            "tool_failure",
            "other",
        }
    )

    def __init__(
        self,
        *,
        reason: str,
        category: str,
        recoverable: bool,
        suggested_action: str,
    ) -> None:
        self.reason = reason
        self.category = category if category in self.VALID_CATEGORIES else "other"
        self.recoverable = recoverable
        self.suggested_action = suggested_action
        super().__init__(f"Agent planning failure [{self.category}]: {reason}")


# ---------------------------------------------------------------------------
# Tool builder
# ---------------------------------------------------------------------------

_FORBIDDEN_DIR_NAMES: frozenset[str] = frozenset({".git"})


def _is_safe_path(project_root: Path, target: Path) -> bool:
    """Return True when target is inside project_root and not a forbidden subtree."""
    try:
        rel = target.resolve().relative_to(project_root.resolve())
    except ValueError:
        return False
    parts = rel.parts
    return not (parts and parts[0] in _FORBIDDEN_DIR_NAMES)


def build_agent_tools(
    project_root: Path,
    *,
    user_input_mode: str = "interactive",
    user_input_callback: Callable[[str], str] | None = None,
) -> list[dict[str, Any]]:
    """
    Build the complete tool list for the planning agent.

    Each entry is a dict with OpenAI-style ``name``, ``description``, and
    ``parameters`` keys, plus a private ``_execute`` callable that accepts a
    kwargs dict and returns a string result.

    Parameters
    ----------
    project_root:
        Absolute path to the repository root.
    user_input_mode:
        Controls ask_user_input behaviour:
        - ``"interactive"`` — render question and return the user's answer.
        - ``"infer"`` — record as an assumption and return the recommended option.
        - ``"fail"`` — raise ``PlanningInputRequired``.
    user_input_callback:
        Optional callable used in interactive mode instead of stdin/stdout.
        Receives the rendered question string and must return the answer.
    """
    read_cache: dict[str, str] = {}

    # ------------------------------------------------------------------
    # Read-only tools
    # ------------------------------------------------------------------

    def _read_file(path: str) -> str:
        if path in read_cache:
            return read_cache[path]
        target = project_root / path
        if not _is_safe_path(project_root, target):
            return f"Error: path {path!r} is outside the repository root."
        if not target.is_file():
            return f"Error: {path!r} does not exist or is not a file."
        try:
            content = target.read_text(encoding="utf-8", errors="replace")
            read_cache[path] = content
            return content
        except OSError as exc:
            return f"Error reading {path!r}: {exc}"

    def _list_dir(path: str = ".") -> str:
        target = project_root / path
        if not _is_safe_path(project_root, target):
            return f"Error: path {path!r} is outside the repository root."
        if not target.is_dir():
            return f"Error: {path!r} is not a directory."
        try:
            entries = sorted(target.iterdir())
            lines: list[str] = []
            for entry in entries:
                if entry.name.startswith(".") and entry.name in _FORBIDDEN_DIR_NAMES:
                    continue
                rel = entry.relative_to(project_root)
                kind = "dir" if entry.is_dir() else "file"
                lines.append(f"{kind}  {rel}")
            return "\n".join(lines) if lines else "(empty directory)"
        except OSError as exc:
            return f"Error listing {path!r}: {exc}"

    def _search_files(pattern: str, path: str = ".") -> str:
        import fnmatch
        import re

        target = project_root / path
        if not _is_safe_path(project_root, target):
            return f"Error: path {path!r} is outside the repository root."
        if not target.is_dir():
            return f"Error: {path!r} is not a directory."

        results: list[str] = []
        try:
            compiled = re.compile(pattern, re.MULTILINE)
        except re.error:
            compiled = None

        try:
            for entry in sorted(target.rglob("*")):
                if not entry.is_file():
                    continue
                if not _is_safe_path(project_root, entry):
                    continue
                rel = str(entry.relative_to(project_root))
                # Name/path glob match
                if fnmatch.fnmatch(entry.name, pattern) or fnmatch.fnmatch(rel, pattern):
                    results.append(rel)
                    continue
                # Content regex match (best-effort)
                if compiled is not None:
                    try:
                        content = entry.read_text(encoding="utf-8", errors="replace")
                        if compiled.search(content):
                            results.append(rel)
                    except OSError:
                        pass
        except OSError as exc:
            return f"Error searching in {path!r}: {exc}"

        if not results:
            return f"No results for {pattern!r} in {path!r}."
        return "\n".join(results[:200])  # cap to avoid excessive output

    def _file_exists(path: str) -> str:
        target = project_root / path
        if not _is_safe_path(project_root, target):
            return "false"
        return "true" if target.exists() else "false"

    # ------------------------------------------------------------------
    # Terminal pseudo-tools
    # ------------------------------------------------------------------

    def _submit_plan(**kwargs: Any) -> None:
        """
        Deserialise, validate, and submit the plan.

        The agent passes the complete AgentPlanSubmission as keyword
        arguments matching the submit_plan tool schema.

        Raises _SubmissionReceived on success, SubmissionValidationError
        when the submission structure is invalid (caller may re-prompt).
        """
        from .agent_validation import SubmissionValidationError, validate_submission

        submission = _deserialize_submission(kwargs)
        validate_submission(submission)
        raise _SubmissionReceived(submission)

    def _planning_failed(
        reason: str = "Unknown reason",
        category: str = "other",
        recoverable: bool = False,
        suggested_action: str = "",
    ) -> None:
        raise _PlanningFailed(
            reason=reason,
            category=category,
            recoverable=recoverable,
            suggested_action=suggested_action,
        )

    # ------------------------------------------------------------------
    # Interactive pseudo-tool
    # ------------------------------------------------------------------

    def _ask_user_input(
        question: str = "(no question provided)",
        why_needed: str = "",
        options: list[str] | None = None,
        recommended_option: str = "",
    ) -> str:
        if user_input_mode == "interactive":
            if user_input_callback is not None:
                prompt = question
                if options:
                    opts = "\n".join(f"  {i+1}. {o}" for i, o in enumerate(options))
                    prompt = f"{question}\n\nOptions:\n{opts}"
                if recommended_option:
                    prompt += f"\n\n(recommended: {recommended_option})"
                return user_input_callback(prompt)
            # Fall back to stdin/stdout
            import sys

            print(f"\nPlanning agent requires input:\n{question}", file=sys.stderr)
            if why_needed:
                print(f"Why needed: {why_needed}", file=sys.stderr)
            if options:
                for i, opt in enumerate(options, 1):
                    print(f"  {i}. {opt}", file=sys.stderr)
            if recommended_option:
                print(f"  (recommended: {recommended_option})", file=sys.stderr)
            return input("Your answer: ")

        elif user_input_mode == "infer":
            answer = recommended_option or (options[0] if options else "proceed with best judgment")
            return f"(auto-inferred) {answer}"

        else:  # "fail"
            from .strategy import PlanningInputRequired

            raise PlanningInputRequired(question)

    # ------------------------------------------------------------------
    # Tool schema list (OpenAI function-calling format)
    # ------------------------------------------------------------------

    _evidence_item_schema: dict[str, Any] = {
        "type": "object",
        "properties": {
            "path": {
                "type": ["string", "null"],
                "description": "Repository-relative path, or null for general observations.",
            },
            "observation": {
                "type": "string",
                "description": "The observation supporting the assessment.",
            },
        },
        "required": ["observation"],
    }

    _planned_change_schema: dict[str, Any] = {
        "type": "object",
        "properties": {
            "path": {
                "type": "string",
                "description": "Repository-relative file path to create or modify.",
            },
            "description": {
                "type": "string",
                "description": "One-sentence description of the change.",
            },
            "symbols": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Symbol names affected (classes, functions, etc.).",
            },
        },
        "required": ["path", "description"],
    }

    _assessment_schema: dict[str, Any] = {
        "type": "object",
        "properties": {
            "criterion_id": {
                "type": "string",
                "description": "Stable ID assigned to this criterion, e.g. 'AC-1'.",
            },
            "source_criterion": {
                "type": "string",
                "description": "Verbatim criterion text from the ticket.",
            },
            "disposition": {
                "type": "string",
                "enum": ["remaining", "satisfied", "not_applicable", "blocked"],
                "description": "Assessment outcome.",
            },
            "rationale": {
                "type": "string",
                "description": "Justification for the disposition.",
            },
            "evidence": {
                "type": "array",
                "items": _evidence_item_schema,
                "description": "Repository-grounded observations.",
            },
            "planned_changes": {
                "type": "array",
                "items": _planned_change_schema,
                "description": "Non-empty only for 'remaining' criteria.",
            },
            "verification": {
                "type": "string",
                "enum": ["test", "test-refactor", "refactor", "manual"],
                "description": "Required for 'remaining'.",
            },
            "implementation_strategy": {
                "type": "string",
                "enum": ["tdd", "direct", "manual", "refactor"],
                "description": "Required for 'remaining'.",
            },
            "existing_test_refs": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Existing test references: 'path::test_name'.",
            },
            "plan_context": {
                "type": "string",
                "description": "Additional implementation notes.",
            },
            "blocker": {
                "type": "string",
                "description": "Required for 'blocked' criteria.",
            },
        },
        "required": [
            "criterion_id",
            "source_criterion",
            "disposition",
            "rationale",
            "evidence",
        ],
    }

    return [
        # --- Read-only tools ---
        {
            "name": "read_file",
            "description": "Read the full contents of a file in the repository.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Repository-relative file path.",
                    },
                },
                "required": ["path"],
            },
            "_execute": lambda args: _read_file(args["path"]),
        },
        {
            "name": "list_dir",
            "description": "List the entries of a directory in the repository.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Repository-relative path. Defaults to repository root.",
                        "default": ".",
                    },
                },
            },
            "_execute": lambda args: _list_dir(args.get("path", ".")),
        },
        {
            "name": "search_files",
            "description": (
                "Search for files by name glob or content regex pattern. "
                "Returns matching repository-relative paths."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "pattern": {
                        "type": "string",
                        "description": "Glob name pattern (e.g. '*.py') or regex content pattern.",
                    },
                    "path": {
                        "type": "string",
                        "description": "Directory to search within. Defaults to repository root.",
                        "default": ".",
                    },
                },
                "required": ["pattern"],
            },
            "_execute": lambda args: _search_files(
                args["pattern"], args.get("path", ".")
            ),
        },
        {
            "name": "file_exists",
            "description": "Check whether a path exists in the repository.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Repository-relative path.",
                    },
                },
                "required": ["path"],
            },
            "_execute": lambda args: _file_exists(args["path"]),
        },
        # --- Terminal pseudo-tools ---
        {
            "name": "submit_plan",
            "description": (
                "Submit the completed planning result. "
                "This is the ONLY valid successful completion mechanism. "
                "Call once all ticket acceptance criteria have been assessed."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "ticket_summary": {
                        "type": "string",
                        "description": "One-paragraph summary of the ticket.",
                    },
                    "approach_summary": {
                        "type": "string",
                        "description": "One-paragraph summary of the planned approach.",
                    },
                    "assumptions": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "question": {"type": "string"},
                                "answer": {"type": "string"},
                                "basis": {"type": "string"},
                            },
                            "required": ["question", "answer", "basis"],
                        },
                    },
                    "repository_findings": {
                        "type": "array",
                        "items": _evidence_item_schema,
                    },
                    "criteria": {
                        "type": "array",
                        "items": _assessment_schema,
                        "description": "One entry per acceptance criterion.",
                    },
                    "cross_cutting_changes": {
                        "type": "array",
                        "items": _planned_change_schema,
                        "description": "Changes that span multiple criteria.",
                    },
                    "risks": {
                        "type": "array",
                        "items": {"type": "string"},
                    },
                    "validation_notes": {
                        "type": "array",
                        "items": {"type": "string"},
                    },
                },
                "required": [
                    "ticket_summary",
                    "approach_summary",
                    "assumptions",
                    "repository_findings",
                    "criteria",
                ],
            },
            "_execute": lambda args: _submit_plan(**args),
            "_terminal": "success",
        },
        {
            "name": "planning_failed",
            "description": (
                "Report that planning cannot be completed safely. "
                "Use only when a grounded plan is impossible to produce."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "reason": {
                        "type": "string",
                        "description": "Human-readable explanation of why planning failed.",
                    },
                    "category": {
                        "type": "string",
                        "enum": [
                            "insufficient_ticket",
                            "repository_unavailable",
                            "unsupported_repository",
                            "conflicting_requirements",
                            "tool_failure",
                            "other",
                        ],
                    },
                    "recoverable": {
                        "type": "boolean",
                        "description": "Whether the caller could retry after correcting the input.",
                    },
                    "suggested_action": {
                        "type": "string",
                        "description": "What the user or caller should do next.",
                    },
                },
                "required": ["reason", "category"],
            },
            "_execute": lambda args: _planning_failed(
                reason=args.get("reason", "Unknown reason"),
                category=args.get("category", "other"),
                recoverable=bool(args.get("recoverable", False)),
                suggested_action=args.get("suggested_action", ""),
            ),
            "_terminal": "failure",
        },
        # --- Interactive pseudo-tool ---
        {
            "name": "ask_user_input",
            "description": (
                "Request user clarification for a material ambiguity that cannot be "
                "resolved from the ticket, repository, or established conventions. "
                "Do NOT use for low-risk internal implementation choices."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "question": {
                        "type": "string",
                        "description": "The question to put to the user.",
                    },
                    "why_needed": {
                        "type": "string",
                        "description": "Why this question must be answered before planning can proceed.",
                    },
                    "options": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Possible answers, each with implications.",
                    },
                    "recommended_option": {
                        "type": "string",
                        "description": "The option the agent would choose if forced to infer.",
                    },
                },
                "required": ["question"],
            },
            "_execute": lambda args: _ask_user_input(
                question=args.get("question", "(no question provided)"),
                why_needed=args.get("why_needed", ""),
                options=args.get("options"),
                recommended_option=args.get("recommended_option", ""),
            ),
        },
    ]


# ---------------------------------------------------------------------------
# Deserialisation helper
# ---------------------------------------------------------------------------


def _deserialize_submission(data: dict[str, Any]) -> "AgentPlanSubmission":
    """Deserialise a raw argument dict into an AgentPlanSubmission."""
    from .agent_models import (
        AgentAssumption,
        AgentCriterionAssessment,
        AgentEvidence,
        AgentPlanSubmission,
        PlannedChange,
    )

    def _ev(items: list[dict[str, Any]]) -> tuple[AgentEvidence, ...]:
        return tuple(
            AgentEvidence(path=e.get("path"), observation=e["observation"])
            for e in (items or [])
        )

    def _assumptions(items: list[dict[str, Any]]) -> tuple[AgentAssumption, ...]:
        return tuple(
            AgentAssumption(
                question=a["question"], answer=a["answer"], basis=a["basis"]
            )
            for a in (items or [])
        )

    def _changes(items: list[dict[str, Any]]) -> tuple[PlannedChange, ...]:
        return tuple(
            PlannedChange(
                path=c["path"],
                description=c["description"],
                symbols=tuple(c.get("symbols") or []),
            )
            for c in (items or [])
        )

    def _criteria(
        items: list[dict[str, Any]],
    ) -> tuple[AgentCriterionAssessment, ...]:
        return tuple(
            AgentCriterionAssessment(
                criterion_id=c["criterion_id"],
                source_criterion=c["source_criterion"],
                disposition=c["disposition"],
                rationale=c["rationale"],
                evidence=_ev(c.get("evidence") or []),
                planned_changes=_changes(c.get("planned_changes") or []),
                verification=c.get("verification"),
                implementation_strategy=c.get("implementation_strategy"),
                existing_test_refs=tuple(c.get("existing_test_refs") or []),
                plan_context=c.get("plan_context"),
                blocker=c.get("blocker"),
            )
            for c in (items or [])
        )

    return AgentPlanSubmission(
        ticket_summary=data["ticket_summary"],
        approach_summary=data["approach_summary"],
        assumptions=_assumptions(data.get("assumptions") or []),
        repository_findings=_ev(data.get("repository_findings") or []),
        criteria=_criteria(data.get("criteria") or []),
        cross_cutting_changes=_changes(data.get("cross_cutting_changes") or []),
        risks=tuple(data.get("risks") or []),
        validation_notes=tuple(data.get("validation_notes") or []),
    )

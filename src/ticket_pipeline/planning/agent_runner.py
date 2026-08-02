"""
Orchestrates the AgentPlanningStrategy agent loop.

The runner:
1. Builds the initial prompt and tool set.
2. Runs a continuous LLM-plus-tools loop via pipeline_lib.
3. Handles terminal pseudo-tools (submit_plan, planning_failed) via
   exception-based signalling.
4. Retries on invalid submission payloads (up to max_invalid_submissions).
5. Enforces a hard turn ceiling.
6. Logs planning diagnostics to the standard scaffold logger.

The loop uses pipeline_lib's `run_with_tools()`.  Tool callbacks raise
_SubmissionReceived (success) or _PlanningFailed (failure) to terminate
the loop; these exceptions propagate naturally out of run_with_tools().
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import TYPE_CHECKING, Any, Callable

if TYPE_CHECKING:
    from .agent_models import AgentPlanSubmission

logger = logging.getLogger(__name__)

DEFAULT_MAX_TURNS: int = 40
DEFAULT_MAX_INVALID_SUBMISSIONS: int = 2


def run_planning_agent(
    *,
    prompt: str,
    model: str,
    project_root: Path,
    criteria_with_ids: list[tuple[str, str]],
    user_input_mode: str = "interactive",
    user_input_callback: Callable[[str], str] | None = None,
    max_turns: int = DEFAULT_MAX_TURNS,
    max_invalid_submissions: int = DEFAULT_MAX_INVALID_SUBMISSIONS,
) -> "AgentPlanSubmission":
    """
    Run the planning agent and return a validated AgentPlanSubmission.

    Parameters
    ----------
    prompt:
        The full initial prompt as rendered by agent_prompt.build_agent_prompt().
    model:
        LLM model identifier (e.g. 'opencode:claude-sonnet-4-6').
    project_root:
        Absolute path to the repository root.
    criteria_with_ids:
        List of (criterion_id, criterion_text) pairs extracted from the ticket.
    user_input_mode:
        Controls ask_user_input behaviour: 'interactive', 'infer', or 'fail'.
    user_input_callback:
        Optional callable for interactive input (receives question, returns answer).
    max_turns:
        Hard turn ceiling.  Terminal tools define semantic completion; this
        ceiling protects against pathological loops.
    max_invalid_submissions:
        Maximum number of invalid submit_plan payloads the agent may send
        before planning is aborted.

    Returns
    -------
    AgentPlanSubmission
        The validated submission from the agent.

    Raises
    ------
    PlanningError
        On planning failure, turn-ceiling breach, or repeated invalid submissions.
    """
    from .agent_tools import (
        _PlanningFailed,
        _SubmissionReceived,
        build_agent_tools,
    )
    from .agent_validation import SubmissionValidationError
    from .strategy import PlanningError

    expected_ids = frozenset(cid for cid, _ in criteria_with_ids)

    tools = build_agent_tools(
        project_root,
        user_input_mode=user_input_mode,
        user_input_callback=user_input_callback,
    )

    logger.info(
        "-- Agent planning start: model=%s max_turns=%d criteria=%d",
        model,
        max_turns,
        len(criteria_with_ids),
    )

    invalid_submission_count = 0

    # Wrap tool executors to intercept terminal signals and collect metrics
    tool_call_counts: dict[str, int] = {}

    def _execute_tool(tool: dict[str, Any], args: dict[str, Any]) -> Any:
        name = tool["name"]
        tool_call_counts[name] = tool_call_counts.get(name, 0) + 1
        return tool["_execute"](args)

    # The actual LLM loop
    try:
        _run_loop(
            prompt=prompt,
            model=model,
            tools=tools,
            execute_tool=_execute_tool,
            max_turns=max_turns,
            invalid_submission_count_ref=[invalid_submission_count],
            max_invalid_submissions=max_invalid_submissions,
            expected_criterion_ids=expected_ids,
        )
    except _SubmissionReceived as signal:
        submission = signal.submission
        _log_completion(
            submission=submission,
            tool_call_counts=tool_call_counts,
            criteria_with_ids=criteria_with_ids,
        )
        return submission
    except _PlanningFailed as failure:
        logger.warning(
            "-- Agent planning failed [%s]: %s",
            failure.category,
            failure.reason,
        )
        raise PlanningError(
            f"Planning agent reported failure [{failure.category}]: {failure.reason}."
            + (
                f" Suggested action: {failure.suggested_action}"
                if failure.suggested_action
                else ""
            )
        ) from failure

    # Should not reach here — _run_loop raises on turn exhaustion
    raise PlanningError(
        f"Planning agent loop exited without a terminal tool call after "
        f"{max_turns} turns."
    )


# ---------------------------------------------------------------------------
# Internal loop implementation
# ---------------------------------------------------------------------------


def _run_loop(
    *,
    prompt: str,
    model: str,
    tools: list[dict[str, Any]],
    execute_tool: Callable[[dict[str, Any], dict[str, Any]], Any],
    max_turns: int,
    invalid_submission_count_ref: list[int],
    max_invalid_submissions: int,
    expected_criterion_ids: frozenset[str],
) -> None:
    """
    Run the agent tool loop using pipeline_lib.

    Terminal tools raise _SubmissionReceived or _PlanningFailed to exit.
    Plain-text responses without a tool call are treated as a protocol
    violation; a corrective prompt is injected up to max_invalid_submissions
    times before aborting.

    pipeline_lib.run_with_tools() is the primary integration point.  It
    must call the ``_execute`` callback on each tool invocation and must
    propagate exceptions raised by those callbacks.
    """
    from .agent_tools import _SubmissionReceived
    from .agent_validation import SubmissionValidationError
    from .strategy import PlanningError

    try:
        from ..lib import pipeline_lib as lib  # type: ignore[import]
    except ImportError as exc:
        raise PlanningError(
            "pipeline_lib is not available; cannot run the planning agent."
        ) from exc

    # Build the tool spec list for pipeline_lib (schema only, no _execute or _terminal)
    tool_specs = [
        {k: v for k, v in tool.items() if not k.startswith("_")}
        for tool in tools
    ]

    # Build a name→tool map for dispatch
    tool_map = {tool["name"]: tool for tool in tools}

    def tool_executor(name: str, args: dict[str, Any]) -> str:
        """Dispatch a tool call and return its string result."""
        tool = tool_map.get(name)
        if tool is None:
            return f"Error: unknown tool {name!r}."
        # Terminal tools raise exceptions; non-terminal tools return strings
        result = execute_tool(tool, args)
        return str(result) if result is not None else ""

    def on_plain_text(text: str) -> str | None:
        """
        Called when the model produces a plain-text response without a tool call.

        Returns a corrective prompt to inject, or raises PlanningError when
        the invalid-submission limit is exceeded.
        """
        count = invalid_submission_count_ref[0]
        if count < max_invalid_submissions:
            invalid_submission_count_ref[0] += 1
            logger.warning(
                "Agent produced plain-text response (attempt %d/%d). Injecting correction.",
                count + 1,
                max_invalid_submissions,
            )
            return (
                "Protocol violation: you must call submit_plan or planning_failed "
                "to complete planning. A plain-text response is not accepted. "
                "Review the terminal-tool protocol and call submit_plan now."
            )
        raise PlanningError(
            "Planning agent produced plain-text responses without calling a "
            "terminal tool. Planning aborted."
        )

    def on_invalid_submission(error: SubmissionValidationError) -> str | None:
        """
        Called when submit_plan receives an invalid payload.

        Returns a corrective prompt, or raises PlanningError on limit.
        """
        count = invalid_submission_count_ref[0]
        if count < max_invalid_submissions:
            invalid_submission_count_ref[0] += 1
            logger.warning(
                "Agent submitted invalid plan (attempt %d/%d): %s",
                count + 1,
                max_invalid_submissions,
                error,
            )
            return (
                f"Submission validation failed. Please correct the errors and "
                f"call submit_plan again:\n\n{error}"
            )
        raise PlanningError(
            f"Planning agent submitted invalid plans {count + 1} times. "
            f"Last error: {error}"
        )

    # Wrap tool_executor to intercept SubmissionValidationError and inject corrections
    # _SubmissionReceived and _PlanningFailed propagate naturally
    messages: list[dict[str, Any]] = [{"role": "user", "content": prompt}]

    try:
        lib.run_with_tools(
            messages=messages,
            model=model,
            tools=tool_specs,
            tool_executor=tool_executor,
            max_turns=max_turns,
            on_plain_text=on_plain_text,
            on_tool_error=_handle_tool_error(
                on_invalid_submission=on_invalid_submission,
            ),
        )
    except (_SubmissionReceived, _PlanningFailed):
        # Re-raise terminal signals for the caller to handle
        raise
    except PlanningError:
        raise
    except Exception as exc:
        raise PlanningError(
            f"Planning agent loop encountered an unexpected error: {exc}"
        ) from exc

    raise PlanningError(
        f"Planning agent exhausted {max_turns} turns without calling a terminal tool."
    )


def _handle_tool_error(
    *,
    on_invalid_submission: Callable,
) -> Callable:
    """
    Return a callback that handles tool execution errors.

    SubmissionValidationError is intercepted and converted to a corrective
    prompt.  All other exceptions propagate.
    """
    from .agent_validation import SubmissionValidationError

    def handler(exc: Exception) -> str | None:
        if isinstance(exc, SubmissionValidationError):
            return on_invalid_submission(exc)
        raise exc

    return handler


def _log_completion(
    *,
    submission: "AgentPlanSubmission",
    tool_call_counts: dict[str, int],
    criteria_with_ids: list[tuple[str, str]],
) -> None:
    total_criteria = len(submission.criteria)
    remaining = sum(
        1 for a in submission.criteria if a.disposition == "remaining"
    )
    satisfied = sum(
        1 for a in submission.criteria if a.disposition == "satisfied"
    )
    not_applicable = sum(
        1 for a in submission.criteria if a.disposition == "not_applicable"
    )
    blocked = sum(
        1 for a in submission.criteria if a.disposition == "blocked"
    )
    total_calls = sum(tool_call_counts.values())
    read_calls = tool_call_counts.get("read_file", 0)
    search_calls = tool_call_counts.get("search_files", 0)
    listdir_calls = tool_call_counts.get("list_dir", 0)

    logger.info(
        "-- Agent planning complete:\n"
        "   %d ticket criteria assessed\n"
        "   %d remaining\n"
        "   %d already satisfied\n"
        "   %d not applicable\n"
        "   %d blocked\n"
        "   %d tool calls (%d read_file, %d search_files, %d list_dir)",
        total_criteria,
        remaining,
        satisfied,
        not_applicable,
        blocked,
        total_calls,
        read_calls,
        search_calls,
        listdir_calls,
    )

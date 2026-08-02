"""
AgentPlanningStrategy — single-session LLM-driven planning workflow.

The agent owns ticket interpretation, repository inspection, current-state
assessment, implementation planning, verification classification, and final
submission in one continuous context window.

This is the agent-first counterpart to MechanicalPlanningStrategy.  Both
implement the PlanningStrategy protocol and are interchangeable from the
caller's perspective.

Unlike MechanicalPlanningStrategy, this strategy:
- Performs planning and gap analysis in a single agent session.
- Uses read-only repository-exploration tools.
- Requires a structured terminal result via the submit_plan pseudo-tool.
- Returns PlannedCriterion values directly (no markdown serialisation or
  re-parsing required).
- Writes .tdd-plan.md and .gap-plan.md as auditing artifacts, but these
  files are NOT authoritative — the validated structured submission is.

This strategy must not silently fall back to MechanicalPlanningStrategy on
failure.  If the agent fails, a PlanningError is raised.  The user may
explicitly retry with ``--planning-strategy mechanical``.

Configuration keys (under [planning_agent]):
    user_input = "interactive" | "infer" | "fail"
    max_turns = 40
    max_invalid_submissions = 2

Step models key:
    [step_models]
    agent_plan = "opencode:claude-sonnet-4-6"
"""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from ..models import PlanningRequest, PlanningResult

# Default model fallback key used when no agent_plan step model is configured
_AGENT_PLAN_STEP_KEY = "agent_plan"

# Supported user_input modes
_USER_INPUT_MODES = frozenset({"interactive", "infer", "fail"})


class AgentPlanningStrategy:
    """
    Agent-driven planning: one continuous LLM session for the full
    planning and gap-analysis workflow.

    Attributes
    ----------
    user_input_mode:
        Controls how ask_user_input is handled.
        ``"interactive"`` — prompt the user interactively (default).
        ``"infer"`` — auto-select the recommended option and continue.
        ``"fail"`` — raise PlanningInputRequired.
    max_turns:
        Hard turn ceiling for the agent loop (default: 40).
    max_invalid_submissions:
        Maximum invalid submit_plan payloads before aborting (default: 2).
    """

    def __init__(
        self,
        *,
        user_input_mode: str = "interactive",
        max_turns: int = 40,
        max_invalid_submissions: int = 2,
    ) -> None:
        if user_input_mode not in _USER_INPUT_MODES:
            raise ValueError(
                f"Unknown user_input_mode {user_input_mode!r}. "
                f"Valid: {sorted(_USER_INPUT_MODES)}."
            )
        self.user_input_mode = user_input_mode
        self.max_turns = max_turns
        self.max_invalid_submissions = max_invalid_submissions

    def plan(self, request: "PlanningRequest") -> "PlanningResult":
        """
        Run the agent-first planning session and return a PlanningResult.

        Steps
        -----
        1. Extract acceptance criteria and assign stable IDs.
        2. Build the initial agent prompt.
        3. Run the agent loop (repository inspection + structured submission).
        4. Validate the submission.
        5. Write .ticket.md, .tdd-plan.md, .gap-plan.md as audit artifacts.
        6. Convert the submission to PlanningResult and return.

        Raises
        ------
        PlanningError
            When the agent fails, exceeds the turn ceiling, or submits
            invalid plans beyond the allowed retry limit.
        """
        from ..agent_prompt import build_agent_prompt, extract_criteria_with_ids
        from ..agent_rendering import to_planning_result
        from ..agent_runner import run_planning_agent
        from ..strategy import PlanningError

        # Resolve the model for the agent session
        model = request.step_models.get(_AGENT_PLAN_STEP_KEY) or request.model
        if not model:
            raise PlanningError(
                "No model configured for the agent planning session. "
                "Set step_models.agent_plan or the fallback model."
            )

        # Write ticket snapshot so that artifact writers have a consistent source
        try:
            from ...lib import pipeline_lib as lib  # type: ignore[import]

            lib.remove_scratch_files((lib.TICKET_FILE,))
            lib.TICKET_FILE.write_text(request.ticket_content, encoding="utf-8")
        except (ImportError, AttributeError):
            pass  # pipeline_lib unavailable in test environments

        # Extract acceptance criteria with stable IDs
        criteria_with_ids = extract_criteria_with_ids(request.ticket_content)

        # Build the initial agent prompt
        initial_prompt = build_agent_prompt(
            ticket_content=request.ticket_content,
            criteria_with_ids=criteria_with_ids,
            project_root=request.project_root,
        )

        # Run the agent loop
        submission = run_planning_agent(
            prompt=initial_prompt,
            model=model,
            project_root=request.project_root,
            criteria_with_ids=criteria_with_ids,
            user_input_mode=self.user_input_mode,
            max_turns=self.max_turns,
            max_invalid_submissions=self.max_invalid_submissions,
        )

        # Convert to PlanningResult
        result = to_planning_result(submission)

        # Write audit artifacts (.tdd-plan.md and .gap-plan.md)
        self._write_artifacts(result)

        return result

    @staticmethod
    def _write_artifacts(result: "PlanningResult") -> None:
        """
        Write .tdd-plan.md and .gap-plan.md as human-readable audit artifacts.

        These files mirror what MechanicalPlanningStrategy produces so that
        tooling that reads them for human inspection continues to work.
        They are NOT authoritative — the PlanningResult is.
        """
        try:
            from ...lib import pipeline_lib as lib  # type: ignore[import]

            if result.plan_text:
                lib.PLAN_FILE.write_text(result.plan_text, encoding="utf-8")
            if result.narrowed_plan_text:
                lib.GAP_PLAN_FILE.write_text(
                    result.narrowed_plan_text, encoding="utf-8"
                )
        except (ImportError, AttributeError):
            pass  # pipeline_lib unavailable in test environments


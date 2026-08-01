"""
AgentPlanningStrategy — placeholder for the future autonomous LLM-driven
planning workflow.

This class is intentionally unimplemented. Its presence here:

  1. Confirms that the PlanningStrategy interface supports an agent
     implementation without changes to push_ticket.py.
  2. Fails clearly when selected, so a misconfigured environment cannot
     silently fall back to mechanical planning.

When this strategy is fully implemented it will:
  - Inspect the ticket and repository iteratively.
  - Identify and resolve uncertainty.
  - Invoke pseudo-tools such as ask_user_input.
  - Revise earlier conclusions.
  - Challenge its own proposed plan.
  - Produce PlannedCriterion values directly (no markdown serialisation
    or re-parsing required).

See the spec (scratch/scaffold-planning-strategy-spec.md §10) for the
full conceptual flow.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from ..models import PlanningRequest, PlanningResult


class AgentPlanningStrategy:
    """
    Placeholder for the future agent-driven planning workflow.

    Raises PlanningError immediately with a clear message so the user
    knows to select ``planning_strategy = "mechanical"`` instead.

    Must not silently fall back to mechanical planning when the user
    explicitly selects 'agent'.
    """

    def plan(self, request: "PlanningRequest") -> "PlanningResult":  # noqa: ARG002
        from ..strategy import PlanningError

        raise PlanningError(
            "Planning strategy 'agent' is not implemented.\n"
            'Use planning_strategy = "mechanical".'
        )

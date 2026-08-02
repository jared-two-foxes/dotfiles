"""
PlanningStrategy protocol and PlanningError.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Protocol

if TYPE_CHECKING:
    from .models import PlanningRequest, PlanningResult


class PlanningError(RuntimeError):
    """
    Raised when a planning strategy cannot produce a valid PlanningResult.

    push_ticket.py should convert an uncaught PlanningError into the
    current user-facing pipeline failure behaviour.

    Where existing planning functions call die(), the first extraction
    may continue to use existing behaviour internally; the
    strategy-facing contract moves toward raising PlanningError over
    time.
    """


class PlanningInputRequired(PlanningError):
    """
    Raised by AgentPlanningStrategy when the agent calls ask_user_input
    and user_input is configured to ``"fail"``.

    Callers may catch this and re-run with an answer injected via the
    user_input_callback, or surface the question to the user and retry.

    Attributes
    ----------
    question:
        The question the agent needs answered to proceed.
    """

    def __init__(self, question: str) -> None:
        self.question = question
        super().__init__(f"Planning requires user input: {question}")


class PlanningStrategy(Protocol):
    """
    The mechanism used to turn a ticket and repository context into a
    structured set of planned criteria.

    A PlanningStrategy:
    - accepts all required context through PlanningRequest;
    - returns a complete PlanningResult;
    - has no direct knowledge of stack persistence, stack guards,
      CriterionFrame execution state, final ticket validation, or git
      commit state;
    - is synchronous;
    - raises PlanningError for planning-domain failures rather than
      calling sys.exit() where practical.
    """

    def plan(self, request: "PlanningRequest") -> "PlanningResult":
        """
        Produce a PlanningResult for the given request.

        Raises PlanningError if planning fails unrecoverably.
        """
        ...

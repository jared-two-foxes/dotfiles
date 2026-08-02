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

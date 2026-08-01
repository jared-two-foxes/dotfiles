"""
Planning strategy factory.

Resolves a strategy name (from configuration or CLI) into a concrete
PlanningStrategy instance.
"""

from __future__ import annotations

from .mechanical import MechanicalPlanningStrategy
from .agent import AgentPlanningStrategy

__all__ = [
    "MechanicalPlanningStrategy",
    "AgentPlanningStrategy",
    "get_planning_strategy",
]

_REGISTRY: dict[str, type] = {
    "mechanical": MechanicalPlanningStrategy,
    "agent": AgentPlanningStrategy,
}

DEFAULT_PLANNING_STRATEGY = "mechanical"


def get_planning_strategy(name: str | None = None) -> object:
    """
    Return a PlanningStrategy instance for the given strategy name.

    Parameters
    ----------
    name:
        Strategy name, e.g. ``"mechanical"`` or ``"agent"``.
        Defaults to ``"mechanical"`` when ``None`` or an empty string.

    Raises
    ------
    ValueError
        When ``name`` is not a recognised planning strategy name.
    """
    key = (name or DEFAULT_PLANNING_STRATEGY).strip().lower()
    cls = _REGISTRY.get(key)
    if cls is None:
        valid = ", ".join(sorted(_REGISTRY))
        raise ValueError(
            f"Unknown planning strategy {key!r}. Valid options: {valid}."
        )
    return cls()

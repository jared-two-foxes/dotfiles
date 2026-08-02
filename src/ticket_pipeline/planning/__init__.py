"""
ticket_pipeline.planning — planning strategy abstraction.

The planning package separates ticket→criteria conversion from:
  - planning artifact persistence
  - CriterionFrame construction
  - criteria-stack state
  - mechanical grounding checks

Public API
----------
Models:
    PlanningRequest       — inputs to a planning strategy
    PlanningResult        — complete output of a planning strategy
    PlannedCriterion      — one planned acceptance criterion
    PlanningDiagnostic    — optional structured planning information

Strategy interface:
    PlanningStrategy      — Protocol (structural subtyping)
    PlanningError         — raised by strategies on unrecoverable failure

Parsing adapter (mechanical format only):
    parse_gap_plan        — .gap-plan.md text → list[PlannedCriterion]

Frame factory:
    build_ticket_frames   — PlanningResult → list[CriterionFrame]

Strategy resolution:
    from .strategies import get_planning_strategy
"""

from .factory import build_ticket_frames
from .models import (
    PlanningDiagnostic,
    PlanningRequest,
    PlanningResult,
    PlannedCriterion,
)
from .parsing import parse_gap_plan
from .strategy import PlanningError, PlanningStrategy

__all__ = [
    "build_ticket_frames",
    "parse_gap_plan",
    "PlanningDiagnostic",
    "PlanningError",
    "PlanningRequest",
    "PlanningResult",
    "PlannedCriterion",
    "PlanningStrategy",
]

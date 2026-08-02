"""
Converts planning-domain data into CriterionFrame instances for the
criteria-stack pipeline.

This factory is the boundary between the planning layer and the
execution layer. It owns the mapping from PlannedCriterion fields to
CriterionFrame fields.

Important naming rule
---------------------
The existing CLI option ``--strategy`` overrides the implementation
strategy assigned to frames (i.e. CriterionFrame.strategy: tdd/direct).
This option retains that meaning. The parameter here is named
``implementation_strategy_override`` internally to avoid confusion with
the planning strategy (MechanicalPlanningStrategy / AgentPlanningStrategy).
"""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from ..lib.pipeline_lib import CriterionFrame  # type: ignore[import]
    from .models import PlanningResult


def build_ticket_frames(
    *,
    ticket_id: str,
    ticket_content: str,
    planning_result: "PlanningResult",
    implementation_strategy_override: str | None = None,
) -> "list[CriterionFrame]":
    """
    Convert a PlanningResult into a list of CriterionFrame instances
    ready for insertion into the criteria stack.

    Parameters
    ----------
    ticket_id:
        Linear ticket identifier, e.g. 'SA-42'.
    ticket_content:
        The rendered ticket markdown captured at push time. Stored in
        CriterionFrame.ticket_snapshot for TICKET_VALIDATE's re-narrow.
    planning_result:
        The PlanningResult produced by the selected planning strategy.
    implementation_strategy_override:
        When provided, overrides the per-criterion implementation strategy
        (CriterionFrame.strategy) for all frames. This corresponds to the
        --strategy CLI flag, which sets tdd/direct for all seeded frames.

    Returns
    -------
    list[CriterionFrame]
        One frame per PlannedCriterion in planning_result.criteria.
    """
    from ..lib import pipeline_lib as lib  # type: ignore[import]

    return [
        lib.CriterionFrame(
            ticket=ticket_id,
            criterion=item.criterion,
            plan_context=item.plan_context,
            test_files=None,
            test_names=None,
            status="pending",
            origin="ticket",
            verification=item.verification,
            strategy=(
                implementation_strategy_override or item.implementation_strategy
            ),
            existing_test_refs=list(item.existing_test_refs),
            ticket_snapshot=ticket_content,
        )
        for item in planning_result.criteria
    ]

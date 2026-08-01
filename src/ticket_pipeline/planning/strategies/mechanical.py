"""
MechanicalPlanningStrategy — the current fixed fetch→plan→narrow workflow
packaged as a PlanningStrategy implementation.

"Mechanical" describes the orchestration (application code controls the
exact sequence; each model invocation has a bounded, predefined purpose;
intermediate responses conform to markdown formats; markdown is parsed
deterministically) — not the absence of LLM calls.

This preserves the current planning behaviour exactly. The first
implementation wraps existing functions from pipeline_lib rather than
rewriting them, so all existing behaviour is preserved by construction:

  - Current planner and narrower prompts
  - Current model resolution (plan, narrow, fallback)
  - Existing read-only tool access
  - Existing retries
  - Existing logging and token accounting
  - Existing validation that planner/narrower output contains
    '## Acceptance Criteria'
  - Existing writing of .ticket.md, .tdd-plan.md, .gap-plan.md
  - Existing re-entrant block semantics
  - Existing gap-plan parsing semantics
  - Existing no-gap behaviour (empty criteria list)
"""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from ..models import PlanningRequest, PlanningResult


class MechanicalPlanningStrategy:
    """
    Wraps the current fixed fetch→plan→narrow pipeline as a
    PlanningStrategy.

    Internal sequence:

        Prepare planning scratch state
            ↓
        Run mechanical planning blocks (fetch_ticket, planner, narrower)
            ↓
        Read full plan
            ↓
        Read narrowed plan
            ↓
        Parse narrowed plan into PlannedCriterion objects
            ↓
        Return PlanningResult
    """

    def plan(self, request: "PlanningRequest") -> "PlanningResult":
        """
        Run the mechanical plan+narrow pipeline and return a
        PlanningResult.

        The ticket content is written to .ticket.md before calling
        build_planning_blocks so that the planner block's postcondition
        check (TICKET_FILE.is_file()) is satisfied without running
        fetch_ticket again when the content was supplied by the caller
        (e.g. --ticket-file-in).

        Raises PlanningError if either .tdd-plan.md or .gap-plan.md
        cannot be read after the blocks complete. (In practice the
        existing die() calls in pipeline_lib reach sys.exit first; this
        is the long-term target behaviour.)
        """
        from ...lib import pipeline_lib as lib  # type: ignore[import]
        from ..models import PlanningResult
        from ..parsing import parse_gap_plan
        from ..strategy import PlanningError

        lib.remove_scratch_files(
            (
                lib.TICKET_FILE,
                lib.PLAN_FILE,
                lib.GAP_PLAN_FILE,
            )
        )

        lib.TICKET_FILE.write_text(
            request.ticket_content,
            encoding="utf-8",
        )

        lib.walk(
            lib.build_planning_blocks(
                ticket_id=request.ticket_id,
                model=request.model,
                step_models=request.step_models,
                ticket_file_in=lib.TICKET_FILE,
            )
        )

        if not lib.PLAN_FILE.is_file():
            raise PlanningError(
                f"Planning failed: {lib.PLAN_FILE} was not produced."
            )
        if not lib.GAP_PLAN_FILE.is_file():
            raise PlanningError(
                f"Planning failed: {lib.GAP_PLAN_FILE} was not produced."
            )

        plan_text = lib.PLAN_FILE.read_text(encoding="utf-8")
        narrowed_plan_text = lib.GAP_PLAN_FILE.read_text(encoding="utf-8")

        criteria = parse_gap_plan(narrowed_plan_text)

        return PlanningResult(
            criteria=tuple(criteria),
            plan_text=plan_text,
            narrowed_plan_text=narrowed_plan_text,
        )

"""
Mechanical markdown adapter: converts a gap-plan markdown string into a
list of PlannedCriterion instances.

This adapter is specific to the mechanical planning format produced by
the plan+narrow pipeline blocks. No future planning strategy should be
required to call it.
"""

from __future__ import annotations

from .models import PlannedCriterion


def parse_gap_plan(gap_plan_text: str) -> list[PlannedCriterion]:
    """
    Convert the text of a .gap-plan.md file into a list of
    PlannedCriterion instances.

    Delegates to the existing pipeline_lib extraction helpers so that
    all tag-parsing behaviour (verify:, strategy:, existing_test:) is
    preserved exactly.
    """
    # Import here to avoid a hard coupling at module level: callers that
    # only use the planning models without the full scaffold source tree
    # can still import planning.models and planning.strategy.
    from ..lib import pipeline_lib as lib  # type: ignore[import]

    criteria = lib.extract_acceptance_criteria(gap_plan_text)
    return [
        PlannedCriterion(
            criterion=criterion,
            plan_context=lib.extract_plan_context_for_criterion(
                criterion,
                gap_plan_text,
            ),
            verification=lib.extract_verification_mode(criterion),
            implementation_strategy=lib.extract_strategy(criterion),
            existing_test_refs=tuple(
                lib.extract_existing_test_refs(criterion)
            ),
        )
        for criterion in criteria
    ]

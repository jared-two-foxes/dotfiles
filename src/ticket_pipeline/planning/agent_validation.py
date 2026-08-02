"""
Validates an AgentPlanSubmission before converting it to PlanningResult.

Structural validation ensures:
- required fields are present and non-empty;
- dispositions, verification modes, and implementation strategies are
  drawn from the supported value sets;
- criterion IDs match the expected set (when provided);
- disposition-specific constraints hold (e.g. remaining requires
  planned_changes; satisfied requires evidence; blocked requires a blocker).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

from .agent_models import (
    VALID_DISPOSITIONS,
    VALID_IMPLEMENTATION_STRATEGIES,
    VALID_VERIFICATION,
)

if TYPE_CHECKING:
    from .agent_models import AgentCriterionAssessment, AgentPlanSubmission


@dataclass
class _ValidationError:
    field: str
    message: str

    def __str__(self) -> str:
        return f"{self.field}: {self.message}"


class SubmissionValidationError(ValueError):
    """Raised when an AgentPlanSubmission fails structural or content validation."""

    def __init__(self, errors: list[_ValidationError]) -> None:
        self.errors = errors
        messages = "\n".join(f"  {e}" for e in errors)
        super().__init__(f"Submission validation failed:\n{messages}")


def validate_submission(
    submission: "AgentPlanSubmission",
    expected_criterion_ids: frozenset[str] | None = None,
) -> None:
    """
    Validate the structure and contents of an AgentPlanSubmission.

    Parameters
    ----------
    submission:
        The submission returned by the agent via submit_plan.
    expected_criterion_ids:
        When provided, every ID in this set must appear exactly once in
        submission.criteria, and no unknown IDs may be present.

    Raises
    ------
    SubmissionValidationError
        When any validation constraint is violated.
    """
    errors: list[_ValidationError] = []

    if not submission.ticket_summary.strip():
        errors.append(_ValidationError("ticket_summary", "Must not be empty."))
    if not submission.approach_summary.strip():
        errors.append(_ValidationError("approach_summary", "Must not be empty."))
    if not submission.criteria:
        errors.append(
            _ValidationError("criteria", "Must contain at least one assessment.")
        )

    # Duplicate criterion IDs
    seen_ids: dict[str, int] = {}
    for i, assessment in enumerate(submission.criteria):
        cid = assessment.criterion_id
        if cid in seen_ids:
            errors.append(
                _ValidationError(
                    f"criteria[{i}].criterion_id",
                    f"Duplicate criterion_id {cid!r} "
                    f"(also at index {seen_ids[cid]}).",
                )
            )
        else:
            seen_ids[cid] = i

    # Coverage against expected IDs
    if expected_criterion_ids is not None:
        submitted_ids = frozenset(seen_ids)
        for mid in sorted(expected_criterion_ids - submitted_ids):
            errors.append(
                _ValidationError(
                    "criteria",
                    f"Missing assessment for criterion {mid!r}.",
                )
            )
        for eid in sorted(submitted_ids - expected_criterion_ids):
            errors.append(
                _ValidationError(
                    "criteria",
                    f"Unknown criterion_id {eid!r}.",
                )
            )

    for assessment in submission.criteria:
        errors.extend(_validate_assessment(assessment))

    if errors:
        raise SubmissionValidationError(errors)


def _validate_assessment(
    assessment: "AgentCriterionAssessment",
) -> list[_ValidationError]:
    errors: list[_ValidationError] = []
    aid = assessment.criterion_id or "?"

    if not assessment.criterion_id.strip():
        errors.append(_ValidationError("criteria[?].criterion_id", "Must not be empty."))
    if not assessment.source_criterion.strip():
        errors.append(
            _ValidationError(f"criteria[{aid}].source_criterion", "Must not be empty.")
        )
    if not assessment.rationale.strip():
        errors.append(
            _ValidationError(f"criteria[{aid}].rationale", "Must not be empty.")
        )

    if assessment.disposition not in VALID_DISPOSITIONS:
        errors.append(
            _ValidationError(
                f"criteria[{aid}].disposition",
                f"Invalid value {assessment.disposition!r}. "
                f"Valid: {sorted(VALID_DISPOSITIONS)}.",
            )
        )

    if (
        assessment.verification is not None
        and assessment.verification not in VALID_VERIFICATION
    ):
        errors.append(
            _ValidationError(
                f"criteria[{aid}].verification",
                f"Invalid value {assessment.verification!r}. "
                f"Valid: {sorted(VALID_VERIFICATION)}.",
            )
        )

    if (
        assessment.implementation_strategy is not None
        and assessment.implementation_strategy not in VALID_IMPLEMENTATION_STRATEGIES
    ):
        errors.append(
            _ValidationError(
                f"criteria[{aid}].implementation_strategy",
                f"Invalid value {assessment.implementation_strategy!r}. "
                f"Valid: {sorted(VALID_IMPLEMENTATION_STRATEGIES)}.",
            )
        )

    disposition = assessment.disposition

    if disposition == "remaining":
        if not assessment.planned_changes:
            errors.append(
                _ValidationError(
                    f"criteria[{aid}].planned_changes",
                    "Remaining criteria must have at least one planned change.",
                )
            )
        if not assessment.verification:
            errors.append(
                _ValidationError(
                    f"criteria[{aid}].verification",
                    "Remaining criteria must specify verification mode.",
                )
            )
        if not assessment.implementation_strategy:
            errors.append(
                _ValidationError(
                    f"criteria[{aid}].implementation_strategy",
                    "Remaining criteria must specify implementation strategy.",
                )
            )
        if not assessment.plan_context and not assessment.planned_changes:
            errors.append(
                _ValidationError(
                    f"criteria[{aid}].plan_context",
                    "Remaining criteria must supply plan_context or planned_changes.",
                )
            )

    elif disposition == "satisfied":
        if not assessment.evidence:
            errors.append(
                _ValidationError(
                    f"criteria[{aid}].evidence",
                    "Satisfied criteria must provide concrete evidence.",
                )
            )
        if assessment.planned_changes:
            errors.append(
                _ValidationError(
                    f"criteria[{aid}].planned_changes",
                    "Satisfied criteria must not contain planned changes.",
                )
            )

    elif disposition == "not_applicable":
        if assessment.planned_changes:
            errors.append(
                _ValidationError(
                    f"criteria[{aid}].planned_changes",
                    "Not-applicable criteria must not contain planned changes.",
                )
            )
        if not assessment.rationale.strip():
            errors.append(
                _ValidationError(
                    f"criteria[{aid}].rationale",
                    "Not-applicable criteria require strong rationale.",
                )
            )

    elif disposition == "blocked":
        if not assessment.blocker:
            errors.append(
                _ValidationError(
                    f"criteria[{aid}].blocker",
                    "Blocked criteria must describe the blocker.",
                )
            )
        if assessment.planned_changes:
            errors.append(
                _ValidationError(
                    f"criteria[{aid}].planned_changes",
                    "Blocked criteria must not contain fabricated planned changes.",
                )
            )

    return errors

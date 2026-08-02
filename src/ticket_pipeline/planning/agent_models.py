"""
Internal agent submission models for AgentPlanningStrategy.

These types are private to the agent planning module and must not be
exposed through PlanningResult or CriterionFrame.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

CriterionDisposition = Literal[
    "remaining",
    "satisfied",
    "not_applicable",
    "blocked",
]

VALID_DISPOSITIONS: frozenset[str] = frozenset(
    {"remaining", "satisfied", "not_applicable", "blocked"}
)
VALID_VERIFICATION: frozenset[str] = frozenset(
    {"test", "test-refactor", "refactor", "manual"}
)
VALID_IMPLEMENTATION_STRATEGIES: frozenset[str] = frozenset(
    {"tdd", "direct", "manual", "refactor"}
)


@dataclass(frozen=True)
class AgentEvidence:
    """
    Repository-specific observation supporting a criterion assessment.

    path should identify a repository file whenever practical.
    """

    path: str | None
    observation: str


@dataclass(frozen=True)
class AgentAssumption:
    """An inferred or user-supplied answer to a material ambiguity."""

    question: str
    answer: str
    basis: str


@dataclass(frozen=True)
class PlannedChange:
    """One atomic file-level change that satisfies one or more criteria."""

    path: str
    description: str
    symbols: tuple[str, ...] = field(default_factory=tuple)


@dataclass(frozen=True)
class AgentCriterionAssessment:
    """The agent's assessment of one acceptance criterion."""

    criterion_id: str
    """Stable ID assigned before the session, e.g. 'AC-1'."""

    source_criterion: str
    """The verbatim criterion text from the ticket."""

    disposition: CriterionDisposition
    """remaining | satisfied | not_applicable | blocked"""

    rationale: str
    """Human-readable justification for the disposition."""

    evidence: tuple[AgentEvidence, ...]
    """Repository-grounded observations supporting the assessment."""

    planned_changes: tuple[PlannedChange, ...] = field(default_factory=tuple)
    """Non-empty only for 'remaining' criteria."""

    verification: str | None = None
    """One of: test, test-refactor, refactor, manual. Required for remaining."""

    implementation_strategy: str | None = None
    """One of: tdd, direct, manual, refactor. Required for remaining."""

    existing_test_refs: tuple[str, ...] = field(default_factory=tuple)
    """Paths in 'path/to/test.py::test_name' format."""

    plan_context: str | None = None
    """Additional free-text context for the criterion (implementation notes)."""

    blocker: str | None = None
    """Non-empty only for 'blocked' criteria."""


@dataclass(frozen=True)
class AgentPlanSubmission:
    """
    The richer internal model submitted by the planning agent via submit_plan.

    This is converted to PlanningResult by agent_rendering.to_planning_result().
    """

    ticket_summary: str
    approach_summary: str
    assumptions: tuple[AgentAssumption, ...]
    repository_findings: tuple[AgentEvidence, ...]
    criteria: tuple[AgentCriterionAssessment, ...]
    cross_cutting_changes: tuple[PlannedChange, ...] = field(default_factory=tuple)
    risks: tuple[str, ...] = field(default_factory=tuple)
    validation_notes: tuple[str, ...] = field(default_factory=tuple)

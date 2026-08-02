"""
Planning-domain models.

These models represent the planning layer between a ticket and the
criteria-stack execution pipeline. They are intentionally separate from
CriterionFrame: CriterionFrame carries execution state (status, test
files, commit SHAs); these models carry only planning-time information.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

DiagnosticLevel = Literal["info", "warning", "error"]


@dataclass(frozen=True)
class PlanningRequest:
    """
    All inputs a PlanningStrategy needs to produce a PlanningResult.

    Ticket retrieval must happen outside the planning strategy so that
    every strategy receives the same ticket representation and is not
    coupled to Linear.
    """

    ticket_id: str
    """The ticket identifier, e.g. 'SA-42'. Used for logging and artifact
    attribution."""

    ticket_content: str
    """The complete rendered ticket markdown. Must be fetched before
    constructing a PlanningRequest."""

    project_root: Path
    """Repository root against which planning is performed. The initial
    implementation may use Path.cwd() when the application already
    assumes execution from the repository root."""

    model: str
    """Fallback model resolved by the existing model configuration system.
    Used for any step that does not have an explicit step_models entry."""

    step_models: dict[str, str]
    """Per-step model overrides, e.g. {'plan': 'opencode:o4-mini',
    'narrow': 'opencode:gpt-5.4-mini'}. An empty dict means every step
    falls back to ``model``."""


@dataclass(frozen=True)
class PlannedCriterion:
    """
    A planning-domain representation of one actionable acceptance
    criterion.

    Does not carry execution state. Downstream code converts these into
    CriterionFrame instances via build_ticket_frames().
    """

    criterion: str
    """The complete acceptance-criterion text. For mechanical planning
    this retains the original markdown bullet and metadata comment for
    compatibility with downstream parsers."""

    plan_context: str
    """Implementation-plan context relevant to this criterion. Must
    contain enough information for the test-writer and implementor
    steps."""

    verification: str = "test"
    """One of: 'test', 'test-refactor', 'refactor', 'manual'."""

    implementation_strategy: str = "tdd"
    """One of: 'tdd', 'direct', 'manual', 'refactor'.
    Maps to CriterionFrame.strategy — distinct from the planning
    strategy selection."""

    existing_test_refs: tuple[str, ...] = field(default_factory=tuple)
    """Zero or more existing test references in the format
    'path/to/test_file.py::qualified_test_name'. Use an immutable tuple
    in the planning model; convert to list when constructing
    CriterionFrame."""


@dataclass(frozen=True)
class PlanningDiagnostic:
    """
    Optional structured planning information.

    Diagnostics describe inferred assumptions, unsupported ticket
    structure, ambiguities resolved automatically, or fallbacks used.
    They must not be used as criteria-stack state.
    """

    level: DiagnosticLevel
    message: str
    code: str | None = None


@dataclass(frozen=True)
class PlanningResult:
    """
    The complete result returned by a planning strategy.

    ``criteria`` is authoritative. Downstream frame construction must
    use this field rather than reparsing ``plan_text`` or
    ``narrowed_plan_text``.
    """

    criteria: tuple[PlannedCriterion, ...]
    """The authoritative structured output. One entry per remaining
    acceptance criterion."""

    plan_text: str | None = None
    """Optional human-readable full plan. For the mechanical strategy
    this contains the current .tdd-plan.md content."""

    narrowed_plan_text: str | None = None
    """Optional human-readable narrowed or gap plan. For the mechanical
    strategy this contains the current .gap-plan.md content. An agent
    strategy may leave this as None or provide a synthesized summary."""

    diagnostics: tuple[PlanningDiagnostic, ...] = field(default_factory=tuple)
    """Optional structured planning information."""

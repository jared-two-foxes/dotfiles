from __future__ import annotations

from dataclasses import dataclass

from ticket_pipeline.lib import ai_client as shared_ai  # noqa: E402
from ticket_pipeline.lib import tools as shared_tools  # noqa: E402

DEFAULT_MODEL = "opencode:gpt-5.4-mini"
DEFAULT_MAX_TURNS = 40


@dataclass(frozen=True)
class GenerationResult:
    plan: str
    summary: str
    written_paths: list[str]


def build_dependency_plan_prompt(acceptance_criteria: str) -> str:
    return (
        "You are planning a dependency-driven implementation.\n\n"
        "Given acceptance criteria, produce:\n"
        "1) A compact dependency graph (lowest-level dependencies first)\n"
        "2) For each dependency node: contract (inputs/outputs/invariants/failure modes)\n"
        "3) A recommended implementation order\n"
        "4) Any high-risk assumptions requiring explicit evidence\n\n"
        "Keep output concise and implementation-focused.\n\n"
        "Acceptance criteria:\n"
        f"{acceptance_criteria.strip()}\n"
    )


def build_codegen_prompt(acceptance_criteria: str, dependency_plan: str) -> str:
    return (
        "You are a dependency-driven code generator operating directly in this repository.\n\n"
        "Use only the provided tools to inspect and edit files.\n"
        "Implement the requested change in the smallest coherent steps, following dependency order.\n"
        "Prefer updating existing files over creating new abstractions unless needed.\n"
        "Do not add ticket workflow or state-management logic.\n\n"
        "Reference acceptance criteria:\n"
        f"{acceptance_criteria.strip()}\n\n"
        "Dependency-driven plan:\n"
        f"{dependency_plan.strip()}\n\n"
        "Execution requirements:\n"
        "- Read relevant files first.\n"
        "- Write complete file contents with write_file.\n"
        "- Keep changes scoped to this request.\n"
        "- End with a concise summary of files changed and what was implemented.\n"
    )


def generate_from_criteria(
    acceptance_criteria: str,
    model: str = DEFAULT_MODEL,
    max_turns: int = DEFAULT_MAX_TURNS,
) -> GenerationResult:
    plan_result = shared_ai.run_prompt(
        build_dependency_plan_prompt(acceptance_criteria),
        label="ddd-plan",
        model=model,
    )
    dependency_plan = plan_result.text.strip()

    written_paths: list[str] = []
    executor = shared_tools.make_executor(written_paths=written_paths, allow_write=True)
    impl_result = shared_ai.run_with_tools(
        build_codegen_prompt(acceptance_criteria, dependency_plan),
        tools=shared_tools.READ_WRITE_TOOLS,
        executor=executor,
        label="ddd-generate",
        model=model,
        summarize_call=shared_tools.summarize_tool_call,
        max_turns=max_turns,
    )
    return GenerationResult(
        plan=dependency_plan,
        summary=impl_result.text.strip(),
        written_paths=sorted(set(written_paths)),
    )

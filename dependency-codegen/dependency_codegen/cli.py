from __future__ import annotations

import argparse
import sys
from pathlib import Path

from . import runner


def _read_acceptance_criteria(args: argparse.Namespace) -> str:
    input_sources_provided = [
        bool(args.acceptance_criteria),
        bool(args.acceptance_criteria_file),
        bool(args.stdin),
    ]
    if sum(input_sources_provided) > 1:
        raise ValueError("provide only one of --acceptance-criteria, --acceptance-criteria-file, or --stdin")

    if args.acceptance_criteria:
        text = args.acceptance_criteria
    elif args.acceptance_criteria_file:
        text = Path(args.acceptance_criteria_file).read_text(encoding="utf-8")
    elif args.stdin:
        text = sys.stdin.read()
    else:
        raise ValueError("acceptance criteria input is required")

    if not text.strip():
        raise ValueError("acceptance criteria cannot be empty")
    return text


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Generate code in-place from acceptance criteria using a dependency-driven flow."
    )
    parser.add_argument("--acceptance-criteria", help="Acceptance criteria text input.")
    parser.add_argument("--acceptance-criteria-file", help="Path to a file containing acceptance criteria.")
    parser.add_argument("--stdin", action="store_true", help="Read acceptance criteria from stdin.")
    parser.add_argument("--model", default=runner.DEFAULT_MODEL, help="Model id for planning and generation.")
    parser.add_argument(
        "--max-turns",
        type=int,
        default=runner.DEFAULT_MAX_TURNS,
        help="Maximum tool-call conversation turns for the generation step.",
    )
    parser.add_argument("--show-plan", action="store_true", help="Print the generated dependency plan before summary.")
    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    try:
        acceptance_criteria = _read_acceptance_criteria(args)
    except ValueError as exc:
        parser.error(str(exc))
        return

    try:
        result = runner.generate_from_criteria(
            acceptance_criteria=acceptance_criteria,
            model=args.model,
            max_turns=args.max_turns,
        )
    except Exception as exc:
        print(f"dep-scaffold failed: {exc}", file=sys.stderr)
        sys.exit(1)

    if args.show_plan:
        print("## Dependency Plan")
        print(result.plan)
        print()

    print("## Generation Summary")
    print(result.summary or "(no summary)")
    print()
    if result.written_paths:
        print("## Files Written")
        for path in result.written_paths:
            print(f"- {path}")
    else:
        print("## Files Written")
        print("(none)")


if __name__ == "__main__":
    main()

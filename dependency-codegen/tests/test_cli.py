import io
import sys
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "ticket-pipeline"))

from dependency_codegen import cli, runner


class ReadAcceptanceCriteriaTests(unittest.TestCase):
    def _args(self, **overrides):
        base = {
            "acceptance_criteria": None,
            "acceptance_criteria_file": None,
            "stdin": False,
        }
        base.update(overrides)
        return SimpleNamespace(**base)

    def test_reads_inline_text(self):
        text = cli._read_acceptance_criteria(self._args(acceptance_criteria="do x"))
        self.assertEqual("do x", text)

    def test_rejects_multiple_sources(self):
        with self.assertRaises(ValueError):
            cli._read_acceptance_criteria(
                self._args(acceptance_criteria="x", stdin=True)
            )


class GenerationFlowTests(unittest.TestCase):
    def test_generate_uses_shared_runtime(self):
        fake_plan = SimpleNamespace(text="plan")
        fake_impl = SimpleNamespace(text="implemented")
        fake_executor = mock.Mock(return_value="ok")
        with (
            mock.patch.object(runner.shared_ai, "run_prompt", return_value=fake_plan) as run_prompt,
            mock.patch.object(runner.shared_tools, "make_executor", return_value=fake_executor) as make_executor,
            mock.patch.object(runner.shared_ai, "run_with_tools", return_value=fake_impl) as run_with_tools,
        ):
            result = runner.generate_from_criteria("acceptance", model="m", max_turns=7)

        run_prompt.assert_called_once()
        make_executor.assert_called_once_with(
            written_paths=mock.ANY,
            allow_write=True,
        )
        run_with_tools.assert_called_once()
        self.assertIs(run_with_tools.call_args.kwargs["executor"], fake_executor)
        self.assertEqual("plan", result.plan)
        self.assertEqual("implemented", result.summary)

    def test_cli_prints_summary_and_files(self):
        fake = runner.GenerationResult(
            plan="plan text",
            summary="done",
            written_paths=["a.py", "b.py"],
        )
        with (
            mock.patch.object(cli.runner, "generate_from_criteria", return_value=fake),
            mock.patch("sys.argv", ["dep-scaffold", "--acceptance-criteria", "ship feature"]),
        ):
            out = io.StringIO()
            with redirect_stdout(out):
                cli.main()
        text = out.getvalue()
        self.assertIn("## Generation Summary", text)
        self.assertIn("- a.py", text)
        self.assertIn("- b.py", text)


if __name__ == "__main__":
    unittest.main()

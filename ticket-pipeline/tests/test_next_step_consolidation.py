import io
import subprocess
import sys
import types
import unittest
from unittest import mock

render_stub = types.ModuleType("ticket_pipeline.lib.render")
render_stub.render_markdown = lambda _text: None
render_stub.print_line = lambda _text="": None
sys.modules.setdefault("ticket_pipeline.lib.render", render_stub)

from ticket_pipeline import cli, next_step
from ticket_pipeline.lib import pipeline_lib as lib


class NextStepDispatchTests(unittest.TestCase):
    def _frame(self, *, verification="test", status="test-written"):
        return lib.CriterionFrame(
            ticket="SA-1",
            criterion="- [ ] do the thing",
            plan_context="ctx",
            test_files=["tests/test_example.py"] if verification != "manual" else None,
            test_names=["tests::example"] if verification != "manual" else None,
            status=status,
            origin="ticket",
            verification=verification,
        )

    def test_test_written_dispatches_to_implementation_phase(self):
        frame = self._frame()
        with mock.patch.object(lib, "load_stack", return_value=[frame]), \
             mock.patch.object(next_step, "_run_implementation_phase") as run_impl:
            next_step.step("model", {"build_cmd": "true"}, False, lib.PIPELINE_CONFIG_FILE)
        run_impl.assert_called_once()

    def test_awaiting_manual_dispatches_to_implementation_phase(self):
        frame = self._frame(verification="manual", status=next_step.MANUAL_PENDING_STATUS)
        with mock.patch.object(lib, "load_stack", return_value=[frame]), \
             mock.patch.object(next_step, "_run_implementation_phase") as run_impl:
            next_step.step("model", {"build_cmd": "true"}, False, lib.PIPELINE_CONFIG_FILE)
        run_impl.assert_called_once()

    def test_baseline_confirmed_dispatches_to_implementation_phase(self):
        frame = self._frame(verification="refactor", status=lib.BASELINE_CONFIRMED_STATUS)
        with mock.patch.object(lib, "load_stack", return_value=[frame]), \
             mock.patch.object(next_step, "_run_implementation_phase") as run_impl:
            next_step.step("model", {"build_cmd": "true"}, False, lib.PIPELINE_CONFIG_FILE)
        run_impl.assert_called_once()


class NextStepContinuousModeTests(unittest.TestCase):
    def _test_frame(self, *, status="test-written", unconfirmed_tests=None):
        return lib.CriterionFrame(
            ticket="SA-1",
            criterion="- [ ] do the thing",
            plan_context="ctx",
            test_files=["tests/test_example.py"],
            test_names=["tests::example"],
            status=status,
            origin="ticket",
            verification="test",
            unconfirmed_tests=unconfirmed_tests or [],
        )

    def _manual_frame(self):
        return lib.CriterionFrame(
            ticket="SA-1",
            criterion="- [ ] update docs",
            plan_context="ctx",
            test_files=None,
            test_names=None,
            status=next_step.MANUAL_PENDING_STATUS,
            origin="ticket",
            verification="manual",
        )

    def test_implementation_phase_continues_under_continuous(self):
        frame = self._test_frame()
        red = subprocess.CompletedProcess(args=["test"], returncode=1, stdout="", stderr="")
        with mock.patch.object(lib, "run_scoped_tests", return_value=[red]), \
             mock.patch("ticket_pipeline.implement_step.run_implement_with_refine", return_value=["src/example.py"]):
            next_step._run_implementation_phase(
                [frame],
                frame,
                "model",
                {"build_cmd": "true"},
                True,
                2,
                False,
                False,
                None,
            )

    def test_implementation_phase_exits_after_single_phase_without_continuous(self):
        frame = self._test_frame()
        red = subprocess.CompletedProcess(args=["test"], returncode=1, stdout="", stderr="")
        with mock.patch.object(lib, "run_scoped_tests", return_value=[red]), \
             mock.patch("ticket_pipeline.implement_step.run_implement_with_refine", return_value=["src/example.py"]):
            with self.assertRaises(SystemExit) as cm:
                next_step._run_implementation_phase(
                    [frame],
                    frame,
                    "model",
                    {"build_cmd": "true"},
                    False,
                    2,
                    False,
                    False,
                    None,
                )
        self.assertEqual(0, cm.exception.code)

    def test_continuous_still_pauses_for_green_unconfirmed(self):
        frame = self._test_frame(
            status=next_step.GREEN_UNCONFIRMED_STATUS,
            unconfirmed_tests=["tests::example"],
        )
        green = subprocess.CompletedProcess(args=["test"], returncode=0, stdout="", stderr="")
        with mock.patch.object(lib, "load_stack", return_value=[frame]), \
             mock.patch.object(lib, "run_scoped_tests", return_value=[green]), \
             mock.patch.object(lib, "save_stack"):
            with self.assertRaises(SystemExit) as cm:
                next_step.step(
                    "model",
                    {"build_cmd": "true"},
                    True,
                    lib.PIPELINE_CONFIG_FILE,
                )
        self.assertEqual(0, cm.exception.code)

    def test_continuous_still_pauses_for_manual_acceptance_without_paths(self):
        frame = self._manual_frame()
        with mock.patch.object(lib, "git_changed_files", return_value=["docs/guide.md"]), \
             mock.patch.object(lib, "extract_referenced_paths", return_value=[]), \
             mock.patch("ticket_pipeline.implement_step.run_implement_direct_with_refine", return_value=["docs/guide.md"]):
            with self.assertRaises(SystemExit) as cm:
                next_step._run_implementation_phase(
                    [frame],
                    frame,
                    "model",
                    {"build_cmd": "true"},
                    True,
                    2,
                    False,
                    False,
                    None,
                )
        self.assertEqual(0, cm.exception.code)


class CliHelpTests(unittest.TestCase):
    def test_top_level_help_omits_retired_commands(self):
        stdout = io.StringIO()
        with mock.patch.object(sys, "argv", ["scaffold", "--help"]), \
             mock.patch("sys.stdout", stdout):
            with self.assertRaises(SystemExit) as cm:
                cli.main()
        self.assertEqual(0, cm.exception.code)
        help_text = stdout.getvalue()
        self.assertIn("next-step", help_text)
        self.assertNotIn("implement-step", help_text)
        self.assertNotIn("\n  drive", help_text)


if __name__ == "__main__":
    unittest.main()

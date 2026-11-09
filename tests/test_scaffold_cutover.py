"""Cross-repository task-only Scaffold CLI smoke checks (SA-602).

Run against the installed, pinned Scaffold checkout in both Linux and Windows CI.
The CLI stores associations; Pi authenticates approvals, receipts, and Git commits
in its independent Node tests. These tests do not assert that fabricated receipts
or commit hashes are trusted by Pi.
"""

from __future__ import annotations

import hashlib
import json
import subprocess
import sys

import pytest


FEATURE_ID = "SA-602"
CONTEXT = "Linear SA-602: verify recursive task-graph delivery without criteria-stack state"
FEATURE = {
    "id": FEATURE_ID,
    "title": "Task-only cutover",
    "objective": "Verify one persistent graph across subprocess boundaries",
    "acceptance_criteria": ["Graph completion requires designed, verified and checkpointed issues"],
    "context": CONTEXT,
    "design_ref": "sha256:" + hashlib.sha256(CONTEXT.encode()).hexdigest(),
    "baseline": "a" * 40,
    "branch": "feature/task-only-cutover",
}


def command(workspace, *args, payload=None, expected=0):
    argv = [sys.executable, "-m", "scaffold_cli.cli", *args]
    result = subprocess.run(
        argv,
        cwd=workspace,
        input=json.dumps(payload) if payload is not None else "",
        capture_output=True,
        text=True,
        timeout=20,
        check=False,
    )
    assert result.returncode == expected, (
        f"{argv}: expected exit {expected}, got {result.returncode}\n"
        f"stdout={result.stdout}\nstderr={result.stderr}"
    )
    return json.loads(result.stdout) if expected == 0 and result.stdout.strip() else result


def tasks(workspace, action, task_id=None, payload=None, expected=0):
    args = [action, "--feature", FEATURE_ID]
    if task_id is not None:
        args += ["--task", task_id]
    if payload is not None:
        args += ["--input", "-"]
    return command(workspace, *args, payload=payload, expected=expected)


@pytest.fixture
def workspace(tmp_path):
    state_dir = tmp_path / ".scaffold"
    state_dir.mkdir()
    # A former installation may leave malformed criteria data. New workflows
    # must neither inspect it nor mutate/delete it.
    historical = {
        ".criteria-stack.json": b"invalid legacy stack JSON {",
        ".criteria-stack.lock": b"untouched legacy lock sentinel",
    }
    for name, body in historical.items():
        (state_dir / name).write_bytes(body)
    return tmp_path, historical


def assert_historical_unchanged(directory, historical):
    for name, body in historical.items():
        assert (directory / ".scaffold" / name).read_bytes() == body


def test_retired_commands_are_not_exposed_and_do_not_touch_legacy_state(workspace):
    directory, historical = workspace
    help_result = subprocess.run(
        [sys.executable, "-m", "scaffold_cli.cli", "--help"],
        cwd=directory, text=True, capture_output=True, timeout=20, check=False,
    )
    assert help_result.returncode == 0
    assert "stack" not in help_result.stdout
    assert "status" not in help_result.stdout
    assert "summary" in help_result.stdout
    assert "init" in help_result.stdout
    assert "clean" in help_result.stdout

    for legacy in ("stack", "status", "tasks", "fetch-ticket"):
        rejected = command(directory, legacy, expected=2)
        assert "unknown command" in rejected.stderr
    assert not (directory / ".scaffold" / "tasks.json").exists()
    assert not (directory / ".scaffold" / "features").exists()
    assert_historical_unchanged(directory, historical)


def test_ledger_lifecycle_persists_across_subprocesses_and_ignores_legacy_files(workspace):
    directory, historical = workspace
    legacy_state = directory / ".scaffold" / "tasks.json"
    legacy_state.write_bytes(b'{"schema_version": 2, "features": {}}')
    legacy_before = legacy_state.read_bytes()

    initialized = tasks(directory, "init", payload=FEATURE)
    assert initialized["schema_version"] == 3
    assert initialized["feature"]["workflow"]["kind"] == "recursive-issues/v1"
    assert initialized["feature"]["workflow"]["phase"] == "design"
    [ledger] = (directory / ".scaffold" / "features").glob(FEATURE_ID + ".*/ledger.jsonl")
    assert (directory / ".scaffold" / ".tasks.lock").is_file()

    definitions = [
        {"id": "model", "title": "Model", "objective": "Build the model",
         "acceptance_criteria": ["Model is verified"], "dependencies": []},
        {"id": "api", "title": "API", "objective": "Use the model",
         "acceptance_criteria": ["API is verified"], "dependencies": ["model"]},
    ]
    tasks(directory, "decompose", FEATURE_ID, definitions)
    for identifier in (FEATURE_ID, "model", "api"):
        tasks(directory, "design-record", identifier, {
            "summary": "Design for " + identifier,
            "verification": "Scoped checks for " + identifier,
            "approval": "Fixture representing prior human confirmation",
            "disposition": "decomposed" if identifier == FEATURE_ID else "leaf",
        })
    tasks(directory, "design-finish")

    # Scaffold refuses to start without the one direction approval it computes the scope for.
    tasks(directory, "start", "model", expected=1)
    scope = tasks(directory, "list")["feature"]["direction_scope"]
    tasks(directory, "direction-approve", payload={"scope_digest": scope, "capabilities": ["test"]})
    assert tasks(directory, "select")["context"]["issue"]["id"] == "model"

    head = FEATURE["baseline"]

    def finish(identifier, commit_char):
        nonlocal head
        tasks(directory, "start", identifier)
        tree = commit_char * 40
        receipt = command(directory, "artifact-put", "--feature", FEATURE_ID, "--input", "-",
                          payload={"receipt": identifier})["reference"]
        # A completion must cite a recorded PASSED attempt.
        tasks(directory, "complete", identifier, {
            "feature_id": FEATURE_ID, "task_id": identifier, "result": "PASSED",
            "source": "conductor", "reference": receipt, "summary": "x"}, expected=1)
        tasks(directory, "attempt-record", identifier, {
            "attempt": 1, "status": "PASSED", "receipt": receipt, "base": head, "tree": tree})
        tasks(directory, "complete", identifier, {
            "feature_id": FEATURE_ID, "task_id": identifier, "result": "PASSED",
            "source": "conductor", "reference": receipt, "summary": "Fixture evidence association"})
        if identifier == "model":
            blocked = tasks(directory, "start", "api", expected=1)
            assert "checkpoint" in json.loads(blocked.stderr)["error"].lower()
        commit = commit_char * 40
        tasks(directory, "checkpoint-record", identifier, {
            "commit": commit, "parent": head, "tree": tree, "reference": receipt})
        head = commit

    finish("model", "b")
    assert tasks(directory, "select")["context"]["issue"]["id"] == "api"
    finish("api", "c")
    assert tasks(directory, "select")["context"]["issue"]["id"] == FEATURE_ID
    finish(FEATURE_ID, "d")
    assert tasks(directory, "select")["context"] is None

    complete = tasks(directory, "list")["feature"]
    assert complete["head"] == head
    assert [segment["task_id"] for segment in complete["history"]] == ["model", "api", FEATURE_ID]
    assert all(t["status"] == "completed" and t["checkpoint"] for t in complete["tasks"].values())
    assert tasks(directory, "summary")["summary"]["validation_status"] == "awaiting_validation"

    # State is a fold of the ledger: a fresh process reads the same graph, and a lost lock is recreated.
    (directory / ".scaffold" / ".tasks.lock").unlink()
    assert tasks(directory, "list")["feature"]["tasks"] == complete["tasks"]
    assert (directory / ".scaffold" / ".tasks.lock").is_file()
    assert legacy_state.read_bytes() == legacy_before  # a schema-2 file is neither read nor rewritten
    assert ledger.is_file()
    assert_historical_unchanged(directory, historical)


def test_a_damaged_ledger_is_rejected_and_never_rewritten(workspace):
    directory, historical = workspace
    tasks(directory, "init", payload=FEATURE)
    [ledger] = (directory / ".scaffold" / "features").glob(FEATURE_ID + ".*/ledger.jsonl")
    lines = ledger.read_text(encoding="utf-8").splitlines()
    entry = json.loads(lines[0])
    entry["body"] = {**entry["body"], "title": "Tampered"}
    lines[0] = json.dumps(entry)
    ledger.write_text("\n".join(lines) + "\n", encoding="utf-8")
    original = ledger.read_bytes()
    rejected = tasks(directory, "summary", expected=1)
    assert json.loads(rejected.stderr)["error"]
    assert ledger.read_bytes() == original
    assert_historical_unchanged(directory, historical)

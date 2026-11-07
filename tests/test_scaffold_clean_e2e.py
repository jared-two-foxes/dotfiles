"""End-to-end administrative clean cutover against the installed real Scaffold CLI.

These tests run on both Linux and Windows, in disposable Git repositories. They
verify the operator interface and persisted-state effects; Pi's independent
authorization and receipt checks are exercised by the Node integration suite.
No test invokes a destructive command in a developer's real checkout.
"""

from __future__ import annotations

import hashlib
import json
import subprocess
import sys

import pytest


def process(workspace, *arguments, payload=None, expected=0):
    argv = [sys.executable, "-m", "scaffold_cli.cli", *arguments]
    completed = subprocess.run(
        argv,
        cwd=workspace,
        input="" if payload is None else json.dumps(payload),
        capture_output=True,
        text=True,
        check=False,
        timeout=25,
    )
    assert completed.returncode == expected, (
        f"{argv}: expected {expected}, got {completed.returncode}\n"
        f"stdout={completed.stdout}\nstderr={completed.stderr}"
    )
    return completed


def git(workspace, *arguments):
    completed = subprocess.run(
        ["git", *arguments],
        cwd=workspace,
        capture_output=True,
        text=True,
        check=True,
        timeout=20,
    )
    return completed.stdout.strip()


def feature(identifier, baseline):
    context = "Operator-approved feature " + identifier
    return {
        "id": identifier,
        "title": "Clean integration " + identifier,
        "objective": "Verify task-only CLI reset behavior",
        "acceptance_criteria": ["Existing source and evidence remain untouched"],
        "context": context,
        "design_ref": "sha256:" + hashlib.sha256(context.encode()).hexdigest(),
        "baseline": baseline,
        "branch": "feature/clean-e2e",
    }


def tasks(workspace, operation, identifier, *, task=None, payload=None, expected=0):
    arguments = [operation, "--feature", identifier]
    if task is not None:
        arguments.extend(["--task", task])
    if payload is not None:
        arguments.extend(["--input", "-"])
    completed = process(workspace, *arguments, payload=payload, expected=expected)
    return json.loads(completed.stdout) if expected == 0 else completed


def saved(workspace):
    return json.loads((workspace / ".scaffold" / "tasks.json").read_text("utf-8"))


@pytest.fixture
def workspace(tmp_path):
    git(tmp_path, "init", "-q", "-b", "feature/clean-e2e")
    git(tmp_path, "config", "user.name", "Scaffold Test")
    git(tmp_path, "config", "user.email", "scaffold@example.invalid")
    (tmp_path / ".gitignore").write_text(".scaffold/\n", encoding="utf-8")
    (tmp_path / "application.txt").write_text("do not alter application\n", encoding="utf-8")
    git(tmp_path, "add", ".gitignore", "application.txt")
    git(tmp_path, "commit", "-qm", "baseline")

    state_dir = tmp_path / ".scaffold"
    state_dir.mkdir()
    (state_dir / ".criteria-stack.json").write_bytes(b"invalid historical criteria JSON")
    (state_dir / ".criteria-stack.lock").write_bytes(b"retired lock sentinel")
    evidence = tmp_path / ".git" / "pi-conductor-evidence"
    evidence.mkdir()
    (evidence / "retained-old-receipt.json").write_bytes(b"immutable external evidence")
    # Uncommitted source is intentionally also protected by this operation.
    (tmp_path / "application.txt").write_text("source changes must survive\n", encoding="utf-8")
    return tmp_path


def protected_snapshot(workspace):
    state_dir = workspace / ".scaffold"
    return {
        "head": git(workspace, "rev-parse", "HEAD"),
        "branch": git(workspace, "branch", "--show-current"),
        "status": git(workspace, "status", "--porcelain"),
        "application": (workspace / "application.txt").read_bytes(),
        "criteria": (state_dir / ".criteria-stack.json").read_bytes(),
        "legacy_lock": (state_dir / ".criteria-stack.lock").read_bytes(),
        "external": (
            workspace / ".git" / "pi-conductor-evidence" / "retained-old-receipt.json"
        ).read_bytes(),
    }


def assert_protected(workspace, expected):
    assert protected_snapshot(workspace) == expected


def test_scoped_clean_preserves_other_feature_git_and_evidence_then_reinitializes(workspace):
    baseline = git(workspace, "rev-parse", "HEAD")
    first = tasks(workspace, "init", "F1", payload=feature("F1", baseline))
    tasks(workspace, "init", "F2", payload=feature("F2", baseline))
    original_instance = first["feature"]["workflow"]["instance_id"]
    assert len(original_instance) == 32

    # An in-progress feature has design, lifecycle and evidence associations.
    tasks(workspace, "design-record", "F1", task="F1", payload={
        "summary": "Original design",
        "verification": "Check completed tests",
        "approval": "Fixture only, not authenticated Pi permission",
        "disposition": "leaf",
    })
    tasks(workspace, "design-finish", "F1")
    tasks(workspace, "start", "F1", task="F1")
    prior_store = saved(workspace)
    other_feature = prior_store["features"]["F2"]
    task_state = workspace / ".scaffold" / "tasks.json"
    lock_file = workspace / ".scaffold" / ".tasks.lock"
    lock_before = lock_file.read_bytes()
    before = task_state.read_bytes()
    protected = protected_snapshot(workspace)

    dry = process(workspace, "clean", "--feature", "F1", "--dry-run")
    assert "Affected features: 1" in dry.stdout
    assert "F1:" in dry.stdout
    assert task_state.read_bytes() == before

    # A pipe containing the literal 'yes' cannot grant interactive approval.
    rejected = process(workspace, "clean", "--feature", "F1", payload="yes", expected=1)
    assert "Confirmation requires a terminal" in rejected.stderr
    assert task_state.read_bytes() == before

    removed = process(workspace, "clean", "--feature", "F1", "--yes")
    assert "Removed 1 feature(s)" in removed.stdout
    assert saved(workspace)["features"] == {"F2": other_feature}
    assert lock_file.is_file() and lock_file.read_bytes() == lock_before
    assert_protected(workspace, protected)

    # The old active session cannot complete or checkpoint the missing feature.
    completion = tasks(workspace, "complete", "F1", task="F1", payload={
        "feature_id": "F1", "task_id": "F1", "result": "PASSED",
        "source": "conductor", "reference": "retained-old-receipt",
        "summary": "Stale pre-clean result",
    }, expected=1)
    assert completion.returncode == 1
    checkpoint = tasks(workspace, "checkpoint-record", "F1", task="F1", payload={
        "commit": baseline, "reference": "retained-old-receipt",
    }, expected=1)
    assert checkpoint.returncode == 1
    assert saved(workspace)["features"] == {"F2": other_feature}

    recreated = tasks(workspace, "init", "F1", payload=feature("F1", baseline))
    assert recreated["feature"]["workflow"]["instance_id"] != original_instance
    assert recreated["feature"]["design_ref"] == first["feature"]["design_ref"]
    assert recreated["feature"]["tasks"]["F1"]["status"] == "pending"
    assert saved(workspace)["features"]["F2"] == other_feature
    assert_protected(workspace, protected)


def test_all_clean_confirmation_noops_and_schema_validation(workspace):
    baseline = git(workspace, "rev-parse", "HEAD")
    for identifier in ("F1", "F2"):
        tasks(workspace, "init", identifier, payload=feature(identifier, baseline))
    state = workspace / ".scaffold" / "tasks.json"
    before = state.read_bytes()
    protected = protected_snapshot(workspace)

    assert "Affected features: 2" in process(
        workspace, "clean", "--all", "--dry-run"
    ).stdout
    assert state.read_bytes() == before
    denied = process(workspace, "clean", "--all", expected=1)
    assert "Confirmation requires a terminal" in denied.stderr
    assert state.read_bytes() == before

    invalid = process(workspace, "clean", "--all", "--feature", "F1", expected=2)
    assert invalid.stderr and state.read_bytes() == before
    invalid = process(workspace, "clean", expected=2)
    assert invalid.stderr and state.read_bytes() == before

    lock = workspace / ".scaffold" / ".tasks.lock"
    lock_before = lock.read_bytes()
    process(workspace, "clean", "--all", "--yes")
    assert saved(workspace) == {"schema_version": 2, "features": {}}
    assert lock.read_bytes() == lock_before
    assert_protected(workspace, protected)

    empty = state.read_bytes()
    assert "Nothing to clean" in process(workspace, "clean", "--all").stdout
    assert "Nothing to clean" in process(
        workspace, "clean", "--feature", "F1"
    ).stdout
    assert state.read_bytes() == empty

    # Corrupt/unsupported schema never becomes an implicit migration or reset.
    for bad in (b"{invalid JSON", b'{"schema_version":1,"features":{}}'):
        state.write_bytes(bad)
        failure = process(workspace, "clean", "--all", "--yes", expected=1)
        assert "scaffold clean:" in failure.stderr
        assert state.read_bytes() == bad
        assert_protected(workspace, protected)

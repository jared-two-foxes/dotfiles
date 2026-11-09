// Real-Scaffold: parking an active issue for a design change and restoring it, on the ledger.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { git } from "../pi/agent/lib/git/tree.mjs";
import { scaffoldTasks } from "../pi/agent/extensions/scaffold/adapter.mjs";
import { approveFeatureDirection, featureAuthorized } from "../pi/agent/extensions/scaffold/feature-authorization.mjs";
import { suspendIssue, resumeIssue } from "../pi/agent/extensions/execution-recovery/issue-recovery.mjs";
import { authenticateIssueMutation } from "../pi/agent/lib/verification/issue-mutation.mjs";
import { readEvidence } from "../pi/agent/lib/evidence/store.mjs";
import { verifyHistory } from "../pi/agent/lib/verification/history.mjs";

const hasScaffold = spawnSync("scaffold", ["--help"], { encoding: "utf8" }).status === 0;
const real = { skip: !hasScaffold && "Real Scaffold (schema 3) is not on PATH" };

async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-ledger-suspend-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const g = (...args) => git(dir, args);
  g("init", "-q", "-b", "main");
  g("config", "user.name", "Test");
  g("config", "user.email", "test@example.invalid");
  g("config", "core.autocrlf", "false");
  g("config", "core.excludesfile", "");
  await writeFile(path.join(dir, ".gitignore"), ".scaffold/\n");
  await writeFile(path.join(dir, "value.txt"), "before\n");
  g("add", ".");
  g("commit", "-qm", "baseline");
  g("switch", "-qc", "feature/suspend");
  const base = g("rev-parse", "HEAD");
  const context = { directory: dir };
  const call = async (operation, payload, task_id, reason) => {
    const response = await scaffoldTasks({ operation, feature_id: "F1", ...(task_id ? { task_id } : {}),
      ...(reason ? { reason } : {}), ...(payload !== undefined ? { payload } : {}) }, context,
    { authorizeIssueMutation: authenticateIssueMutation });
    assert.equal(response.ok, true, JSON.stringify(response));
    return response.data;
  };
  await call("init", { id: "F1", title: "Feature", objective: "Park and restore", design_ref: "sha256:context",
    context: "Approved design", acceptance_criteria: ["Restored"], baseline: base, branch: "feature/suspend" });
  await call("decompose", [{ id: "a", title: "a", objective: "Do a", acceptance_criteria: ["a works"] }], "F1");
  const design = (id, disposition) => call("design-record", { summary: "s", verification: "v", approval: "user", disposition }, id);
  await design("F1", "decomposed");
  await design("a", "leaf");
  await call("design-finish");
  const approved = await approveFeatureDirection({ featureId: "F1" }, context, { confirm: async () => true });
  assert.equal(approved.ok, true, JSON.stringify(approved));
  const feature = async () => (await call("list")).feature;
  const designRef = (await feature()).design_ref;
  const task = { featureId: "F1", taskId: "a", designRef };
  const scope = { task, branch: "feature/suspend", featureBaseRef: base, defaultBranch: "main", protectedBranches: [] };
  const options = { authorize: () => featureAuthorized({ featureId: "F1" }, context) };
  return { dir, g, base, context, call, feature, design, task, scope, options };
}

test("an active issue with no attempts is parked, redesigned and restored on the ledger", real, async t => {
  const f = await fixture(t);
  await f.call("start", undefined, "a");
  const before = await f.feature();
  assert.equal(before.tasks.a.status, "in_progress");

  const parked = await suspendIssue({ ...f.scope, reason: "Found a prerequisite" }, f.context, f.options);
  assert.equal(parked.status, "DESIGN", JSON.stringify(parked));
  assert.match(parked.suspensionRef, /^sha256:[a-f0-9]{64}$/);
  const reopened = await f.feature();
  assert.equal(reopened.workflow.phase, "design");
  assert.equal(reopened.tasks.a.suspension.reference, parked.suspensionRef);
  // The suspension record is a ledger artifact.
  assert.equal((await readEvidence(f.dir, parked.suspensionRef)).kind, "issue-suspension");

  // Design continues in the same graph, then implementation resumes.
  await f.call("decompose", [{ id: "fix", title: "fix", objective: "Do the prerequisite", acceptance_criteria: ["fix works"] }], "F1");
  await f.design("F1", "decomposed");
  await f.design("fix", "leaf");
  await f.design("a", "leaf");
  await f.call("design-finish");
  assert.equal((await f.feature()).workflow.phase, "implement");

  const restored = await resumeIssue({ ...f.scope, suspensionRef: parked.suspensionRef }, f.context, f.options);
  assert.ok(["READY", "RESTORED"].includes(restored.status), JSON.stringify(restored));
  const after = await f.feature();
  assert.ok(after.tasks.a.suspension.handoff, "the handoff is recorded in the ledger");
  // Restoring never moves history: nothing was committed.
  assert.equal(after.head, f.base);
  verifyHistory(f.dir, after, { head: f.g("rev-parse", "HEAD") });
});

test("parking requires an approved direction, an active issue and a clean tree", real, async t => {
  const f = await fixture(t);
  const idle = await suspendIssue({ ...f.scope, reason: "x" }, f.context, f.options);
  assert.equal(idle.status, "BLOCKED");
  assert.match(idle.message, /active unfinished issue/);
  await f.call("start", undefined, "a");
  await writeFile(path.join(f.dir, "value.txt"), "dirty\n");
  const dirty = await suspendIssue({ ...f.scope, reason: "x" }, f.context, f.options);
  assert.equal(dirty.status, "BLOCKED");
  assert.match(dirty.message, /clean source/);
  assert.equal(await readFile(path.join(f.dir, "value.txt"), "utf8"), "dirty\n"); // never discarded
  assert.equal((await f.feature()).tasks.a.suspension, undefined);
  const unauthorized = await suspendIssue({ ...f.scope, reason: "x" }, f.context, { authorize: async () => false });
  assert.equal(unauthorized.status, "BLOCKED");
});

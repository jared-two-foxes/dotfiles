// Real-Scaffold end to end: execute_and_review stores its receipt as a ledger artifact, records the
// attempt, Scaffold accepts completion only against that attempt, and the checkpoint chains in the ledger.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { git } from "../pi/agent/lib/git/tree.mjs";
import { snapshot } from "../pi/agent/lib/git/snapshot.mjs";
import { scaffoldTasks } from "../pi/agent/extensions/scaffold/adapter.mjs";
import { approveFeatureDirection } from "../pi/agent/extensions/scaffold/feature-authorization.mjs";
import { checkpointVerifiedTask } from "../pi/agent/extensions/checkpoint/scaffold.mjs";
import { readEvidence } from "../pi/agent/lib/evidence/store.mjs";
import { assertLatestAttempt } from "../pi/agent/lib/verification/attempt-chain.mjs";
import { verifyHistory } from "../pi/agent/lib/verification/history.mjs";
import { executeAndReview as executeTaskAttempt } from "./helpers/conductor-v2.mjs";
import { requirementsFor } from "./helpers/issue-plan.mjs";

const hasScaffold = spawnSync("scaffold", ["--help"], { encoding: "utf8" }).status === 0;
const real = { skip: !hasScaffold && "Real Scaffold (schema 3) is not on PATH" };

async function executeAndReview(args, context, options) {
  return executeTaskAttempt(args, context, {
    ...options,
    invokeConductor: async (json) => {
      const result = await options.invokeConductor(json);
      const boundary = JSON.parse(JSON.parse(json).checks.find((c) => c.name === "test").args[1]);
      await writeFile(boundary.output, JSON.stringify(await snapshot(boundary.repository)));
      return result;
    },
  });
}

const outcome = (status, phase = "review", checks) => ({
  code: { PASSED: 0, NEEDS_DESIGN: 2, BLOCKED: 3 }[status],
  stderr: "",
  stdout: JSON.stringify({
    schema: "fixture.delivery-outcome/v1",
    status,
    phase,
    execution: { success: phase !== "execution" },
    checks: checks ?? ["build", "test"].map((name) => ({ name, exit_code: 0, stdout: "2 checks passed" })),
    review: { status: status === "PASSED" ? "APPROVED" : "CHANGES_REQUESTED" },
  }),
});

async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-ledger-delivery-"));
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
  g("switch", "-qc", "feature/delivery");
  const base = g("rev-parse", "HEAD");
  const context = { directory: dir };
  const call = async (operation, payload, task_id) => {
    const response = await scaffoldTasks({ operation, feature_id: "F1", ...(task_id ? { task_id } : {}),
      ...(payload !== undefined ? { payload } : {}) }, context);
    assert.equal(response.ok, true, JSON.stringify(response));
    return response.data;
  };
  await call("init", { id: "F1", title: "Feature", objective: "Deliver", design_ref: "sha256:context",
    context: "Approved design", acceptance_criteria: ["Delivered"], baseline: base, branch: "feature/delivery" });
  await call("decompose", [
    { id: "a", title: "a", objective: "Do a", acceptance_criteria: ["a works"] },
    { id: "b", title: "b", objective: "Do b", acceptance_criteria: ["b works"], dependencies: ["a"] },
  ], "F1");
  for (const [id, disposition] of [["F1", "decomposed"], ["a", "leaf"], ["b", "leaf"]])
    await call("design-record", { summary: "s", verification: "v", approval: "user", disposition }, id);
  await call("design-finish");
  const approved = await approveFeatureDirection({ featureId: "F1" }, context, { confirm: async () => true });
  assert.equal(approved.ok, true, JSON.stringify(approved));
  const feature = async () => (await call("list")).feature;
  const designRef = (await feature()).design_ref;

  // Run one task attempt through the real adapter with a fake Conductor.
  async function attempt(taskId, { status = "PASSED", phase = "review", mutate, previousAttempt } = {}) {
    const state = await feature();
    const task = { featureId: "F1", taskId: taskId, designRef };
    const args = {
      task, baseRef: g("rev-parse", "HEAD"),
      // A continuation inherits its requirements from the retained receipts and Scaffold.
      ...(previousAttempt ? {} : { requirements: requirementsFor(state.tasks[taskId], taskId + " criteria") }),
      input: '{"operations":[]}',
      checks: [{ name: "build", command: ["fixture", "build"] }, { name: "test", command: ["fixture", "test"] }],
      ...(previousAttempt ? { previousAttempt } : {}),
    };
    return executeAndReview(args, context, {
      invokeConductor: async () => {
        await (mutate ?? (async () => writeFile(path.join(dir, "value.txt"), taskId + "\n")))();
        return outcome(status, phase);
      },
    });
  }
  const checkpoint = async (taskId, reference) => checkpointVerifiedTask({
    task: { featureId: "F1", taskId, designRef }, evidenceRef: reference, featureBaseRef: base, branch: "feature/delivery",
    defaultBranch: "main", protectedBranches: [], authorizationMode: "manual",
  }, context, { authorize: async () => true });
  return { dir, g, base, context, call, feature, attempt, checkpoint, designRef };
}

test("a receipt is a ledger artifact, its attempt is recorded, and completion must cite it", real, async (t) => {
  const f = await fixture(t);
  await f.call("start", undefined, "a");
  const result = await f.attempt("a");
  assert.equal(result.status, "PASSED", JSON.stringify(result));
  const reference = result.evidence.reference;
  assert.match(reference, /^sha256:[a-f0-9]{64}$/);

  const state = await f.feature();
  assert.deepEqual(state.tasks.a.attempts.map((a) => [a.attempt, a.status, a.receipt]), [[1, "PASSED", reference]]);
  const receipt = await readEvidence(f.dir, reference);
  assert.equal(receipt.task.taskId, "a");
  assert.equal(receipt.result.status, "PASSED");

  // Scaffold refuses a completion that does not cite a recorded PASSED attempt.
  const forged = await scaffoldTasks({ operation: "complete", feature_id: "F1", task_id: "a",
    payload: { feature_id: "F1", task_id: "a", result: "PASSED", source: "conductor", reference: "sha256:" + "0".repeat(64), summary: "x" } }, f.context);
  assert.equal(forged.ok, false);
  assert.match(forged.stderr, /recorded PASSED attempt/);
});

test("two dependent tasks complete and checkpoint into one chain that verifies against Git", real, async (t) => {
  const f = await fixture(t);
  const finish = async (taskId) => {
    await f.call("start", undefined, taskId);
    const result = await f.attempt(taskId);
    assert.equal(result.status, "PASSED", JSON.stringify(result));
    await f.call("complete", { feature_id: "F1", task_id: taskId, result: "PASSED", source: "conductor",
      reference: result.evidence.reference, summary: "Checks and review passed" }, taskId);
    const checkpoint = await f.checkpoint(taskId, result.evidence.reference);
    assert.equal(checkpoint.ok, true, JSON.stringify(checkpoint));
    return checkpoint;
  };
  const first = await finish("a");
  assert.equal(first.baseRef, f.base);
  assert.match(f.g("show", "-s", "--format=%B", first.commit), /Pi-Checkpoint: a/);
  const second = await finish("b");
  assert.equal(second.baseRef, first.commit);

  const state = await f.feature();
  assert.deepEqual(state.history.map((s) => [s.kind, s.task_id]), [["checkpoint", "a"], ["checkpoint", "b"]]);
  assert.equal(state.head, second.commit);
  verifyHistory(f.dir, state, { head: f.g("rev-parse", "HEAD") });

  // A repeated checkpoint after the entry is recorded is recognised, never duplicated.
  const again = await f.checkpoint("b", (await f.feature()).tasks.b.attempts[0].receipt);
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.equal(again.commit, second.commit);
  assert.equal(f.g("rev-list", "--count", f.base + "..HEAD"), "2");
});

test("every terminal attempt is recorded in sequence and an older receipt is stale", real, async (t) => {
  const f = await fixture(t);
  await f.call("start", undefined, "a");
  const failed = await f.attempt("a", { status: "NEEDS_DESIGN", phase: "verification", mutate: async () => writeFile(path.join(f.dir, "value.txt"), "partial\n") });
  assert.equal(failed.status, "NEEDS_DESIGN", JSON.stringify(failed));
  const second = await f.attempt("a", { previousAttempt: failed.evidence.reference, mutate: async () => writeFile(path.join(f.dir, "value.txt"), "fixed\n") });
  assert.equal(second.status, "PASSED", JSON.stringify(second));
  const recorded = (await f.feature()).tasks.a.attempts;
  assert.deepEqual(recorded.map((a) => [a.attempt, a.status]), [[1, "NEEDS_DESIGN"], [2, "PASSED"]]);
  const binding = { featureId: "F1", taskId: "a", designRef: f.designRef };
  await assertLatestAttempt(f.dir, second.evidence.reference, binding, 2);
  await assert.rejects(assertLatestAttempt(f.dir, failed.evidence.reference, binding, 1), /newer task attempt/);
});

test("execution is refused while HEAD has commits the ledger has not recorded", real, async (t) => {
  const f = await fixture(t);
  await f.call("start", undefined, "a");
  await writeFile(path.join(f.dir, "user.txt"), "user\n");
  f.g("add", ".");
  f.g("commit", "-qm", "user commit");
  const result = await f.attempt("a");
  assert.equal(result.status, "BLOCKED");
  assert.match(JSON.stringify(result), /ledger has not recorded|recorded head/);
  assert.equal((await f.feature()).tasks.a.attempts?.length ?? 0, 0);
});

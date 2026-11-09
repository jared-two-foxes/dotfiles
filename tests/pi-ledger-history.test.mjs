// Real-Scaffold integration: direction approval, ledger history verification, foreign commits.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { git } from "../pi/agent/lib/git/tree.mjs";
import { scaffoldTasks } from "../pi/agent/extensions/scaffold/adapter.mjs";
import {
  approveFeatureDirection,
  featureAuthorized,
  requireFeatureAuthorization,
} from "../pi/agent/extensions/scaffold/feature-authorization.mjs";
import { adoptCommits, inspectDrift } from "../pi/agent/extensions/execution-recovery/foreign-history.mjs";
import { verifyHistory, foreignHistoryRequirements } from "../pi/agent/lib/verification/history.mjs";

const hasScaffold = spawnSync("scaffold", ["--help"], { encoding: "utf8" }).status === 0;
const real = { skip: !hasScaffold && "Real Scaffold (schema 3) is not on PATH" };

async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-ledger-"));
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
  g("switch", "-qc", "feature/ledger");
  const base = g("rev-parse", "HEAD");
  const context = { directory: dir };
  const call = async (operation, payload, task_id) => {
    const response = await scaffoldTasks({ operation, feature_id: "F1", ...(task_id ? { task_id } : {}),
      ...(payload !== undefined ? { payload } : {}) }, context);
    assert.equal(response.ok, true, JSON.stringify(response));
    return response.data;
  };
  const init = () => call("init", { id: "F1", title: "Feature", objective: "Keep history honest",
    design_ref: "sha256:context", context: "Approved design", acceptance_criteria: ["History matches"],
    baseline: base, branch: "feature/ledger" });
  await init();
  await call("decompose", [{ id: "a", title: "a", objective: "Do a", acceptance_criteria: ["a works"] }], "F1");
  for (const [id, disposition] of [["F1", "decomposed"], ["a", "leaf"]])
    await call("design-record", { summary: "s", verification: "v", approval: "user", disposition }, id);
  await call("design-finish");
  const feature = async () => (await call("list")).feature;
  let confirmations = 0;
  const approve = () => approveFeatureDirection({ featureId: "F1" }, context,
    { confirm: async () => { confirmations++; return true; } });
  const user = async (name = "user.txt") => {
    await writeFile(path.join(dir, name), name + "\n");
    g("add", ".");
    g("commit", "-qm", "user: " + name);
    return g("rev-parse", "HEAD");
  };
  const adopt = (from, to, options = {}) => adoptCommits({ featureId: "F1", fromRef: from, toRef: to }, context,
    { confirm: async () => true, ...options });
  return { dir, g, base, context, call, init, feature, approve, user, adopt, confirmations: () => confirmations };
}

const ledgerSnapshot = async f => JSON.stringify((await f.feature()).history) + (await f.feature()).head;

test("direction approval is recorded by Scaffold and required before start", real, async t => {
  const f = await fixture(t);
  const args = { featureId: "F1" };
  assert.equal(await featureAuthorized(args, f.context), false);
  await assert.rejects(requireFeatureAuthorization(args, f.context), /Approve the overall feature direction/);
  const refused = await scaffoldTasks({ operation: "start", feature_id: "F1", task_id: "a" }, f.context);
  assert.equal(refused.ok, false);
  assert.match(refused.stderr, /Approve the feature direction/);

  let shown;
  const result = await approveFeatureDirection(args, f.context, { confirm: async scope => { shown = scope; return true; } });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(shown.baseline, f.base);
  assert.equal(shown.scopeDigest, (await f.feature()).direction_scope);
  assert.equal(await featureAuthorized(args, f.context), true);
  await requireFeatureAuthorization(args, f.context);
  const again = await f.approve();
  assert.equal(again.recovered, true);
  assert.equal(f.confirmations(), 0); // the repeat did not prompt
  assert.equal((await f.call("start", undefined, "a")).task.status, "in_progress");
});

test("approval needs a real confirmation and a recreated feature needs its own", real, async t => {
  const f = await fixture(t);
  for (const confirm of [undefined, async () => false]) {
    const result = await approveFeatureDirection({ featureId: "F1" }, f.context, { confirm });
    assert.equal(result.ok, false);
    assert.match(result.message, /approval required/);
  }
  assert.equal(await featureAuthorized({ featureId: "F1" }, f.context), false);
  assert.equal((await f.approve()).ok, true);
  const before = (await f.feature()).direction_scope;
  spawnSync("scaffold", ["clean", "--feature", "F1", "--yes"], { cwd: f.dir });
  await f.init();
  assert.notEqual((await f.feature()).direction_scope, before);
  assert.equal(await featureAuthorized({ featureId: "F1" }, f.context), false);
});

test("branch and design identity are checked before approval or execution", real, async t => {
  const f = await fixture(t);
  f.g("switch", "-qc", "feature/other");
  assert.match((await f.approve()).message, /Feature branch mismatch/);
  f.g("switch", "-q", "feature/ledger");
  const wrongDesign = await approveFeatureDirection({ featureId: "F1", designRef: "sha256:" + "0".repeat(64) }, f.context, { confirm: async () => true });
  assert.match(wrongDesign.message, /designRef mismatch/);
  f.g("switch", "-q", "main");
  const protectedBranch = await f.approve();
  assert.equal(protectedBranch.ok, false);
});

test("Git is verified against the history the ledger recorded", real, async t => {
  const f = await fixture(t);
  await f.approve();
  let feature = await f.feature();
  assert.deepEqual(verifyHistory(f.dir, feature, { head: f.base }), []);
  const head = await f.user();
  assert.throws(() => verifyHistory(f.dir, feature, { head }), /ledger has not recorded/);
  const drift = await inspectDrift({ featureId: "F1" }, f.context);
  assert.equal(drift.state, "foreign-commits");
  assert.match(drift.recommendation, new RegExp("adopt_foreign_commits with fromRef " + f.base + " and toRef " + head));
  feature = await f.feature();
  assert.equal(feature.head, f.base); // Scaffold never moved on its own
});

test("user commits are recorded between tasks, stay unverified and stay in review scope", real, async t => {
  const f = await fixture(t);
  await f.approve();
  const head = await f.user();
  let shown;
  const result = await f.adopt(f.base, head, { confirm: async scope => { shown = scope; return true; } });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.status, "RECORDED");
  assert.deepEqual(shown.commits.map(c => c.commit), [head]);
  assert.deepEqual(shown.changedPaths, ["user.txt"]);
  const feature = await f.feature();
  assert.equal(feature.head, head);
  assert.equal(feature.original_baseline, f.base); // the original baseline is untouched
  assert.deepEqual(feature.history.map(s => s.kind), ["foreign"]);
  assert.deepEqual(verifyHistory(f.dir, feature, { head }).length, 1);
  const text = foreignHistoryRequirements(feature);
  assert.match(text, /NOT task checkpoints/);
  assert.match(text, new RegExp(head));
  assert.equal(foreignHistoryRequirements({ history: [] }), "");
  assert.equal((await inspectDrift({ featureId: "F1" }, f.context)).state, "authenticated");
});

test("a task checkpoints after the recorded commits and the whole chain verifies against Git", real, async t => {
  const f = await fixture(t);
  await f.approve();
  const head = await f.user();
  assert.equal((await f.adopt(f.base, head)).ok, true);
  await f.call("start", undefined, "a");
  const receipt = (await f.call("artifact-put", { receipt: "a" })).reference;
  const state = await f.feature();
  await writeFile(path.join(f.dir, "value.txt"), "after\n");
  f.g("add", ".");
  f.g("commit", "-qm", "Checkpoint task a\n\nPi-Checkpoint: a");
  const commit = f.g("rev-parse", "HEAD");
  const tree = f.g("rev-parse", "HEAD^{tree}");
  await f.call("attempt-record", { attempt: 1, status: "PASSED", receipt, base: state.head, tree }, "a");
  await f.call("complete", { feature_id: "F1", task_id: "a", result: "PASSED", source: "conductor", reference: receipt, summary: "ok" }, "a");
  const recorded = await f.call("checkpoint-record", { commit, parent: head, tree, reference: receipt }, "a");
  assert.equal(recorded.feature.head, commit);
  const feature = await f.feature();
  assert.deepEqual(feature.history.map(s => s.kind), ["foreign", "checkpoint"]);
  verifyHistory(f.dir, feature, { head: commit });
  // Any divergence between Git and the ledger is detected, not repaired.
  f.g("commit", "-q", "--amend", "-m", "Checkpoint task a (reworded)");
  // The old commit objects still exist, so the recorded chain is intact; HEAD no longer is that chain.
  verifyHistory(f.dir, feature);
  assert.throws(() => verifyHistory(f.dir, feature, { head: f.g("rev-parse", "HEAD") }), /ledger has not recorded/);
  assert.equal((await inspectDrift({ featureId: "F1" }, f.context)).state, "rewritten-history");
});

test("recording is refused without approval, with stale refs, dirty or wrong-branch state, or active work", real, async t => {
  const f = await fixture(t);
  await f.approve();
  const head = await f.user();
  const before = await ledgerSnapshot(f);
  const blocked = async (run, pattern, name) => {
    const result = await run();
    assert.equal(result.ok, false, name);
    assert.match(result.message, pattern, name);
    assert.equal(await ledgerSnapshot(f), before, name + " must not change the ledger");
  };
  for (const confirm of [undefined, async () => false, async () => "yes"])
    await blocked(() => f.adopt(f.base, head, { confirm }), /Explicit user approval/, "confirm " + String(confirm));
  await blocked(() => f.adopt(head, head), /Recorded head mismatch/, "wrong recorded head");
  await blocked(() => f.adopt(f.base, f.base), /Stale HEAD|nothing to record/, "stale to");
  await blocked(() => f.adopt("HEAD", head), /full SHAs/, "malformed");
  await writeFile(path.join(f.dir, "dirty.txt"), "x\n");
  await blocked(() => f.adopt(f.base, head), /clean source tree/, "dirty");
  f.g("add", "dirty.txt");
  await blocked(() => f.adopt(f.base, head), /clean source tree/, "staged");
  f.g("reset", "-q");
  await rm(path.join(f.dir, "dirty.txt"));
  f.g("switch", "-qc", "feature/else");
  await blocked(() => f.adopt(f.base, head), /Branch mismatch/, "branch");
  f.g("switch", "-q", "feature/ledger");
  f.g("commit", "--allow-empty", "-qm", "Task\n\nPi-Checkpoint: a");
  const trailer = f.g("rev-parse", "HEAD");
  await blocked(() => f.adopt(f.base, trailer), /task checkpoint commits/, "unrecorded checkpoint commit");
  f.g("reset", "-q", "--hard", head);
  f.g("commit", "-q", "--amend", "-m", "rewritten user commit");
  const rewritten = f.g("rev-parse", "HEAD");
  assert.notEqual(rewritten, head);
  f.g("reset", "-q", "--hard", rewritten);
  await f.call("start", undefined, "a");
  await blocked(() => f.adopt(f.base, rewritten), /only between tasks/, "active task");
});

test("recording requires an approved direction", real, async t => {
  const f = await fixture(t);
  const head = await f.user();
  const result = await f.adopt(f.base, head);
  assert.equal(result.ok, false);
  assert.match(result.message, /Approve the feature direction/);
  assert.equal((await f.feature()).history.length, 0);
});

test("state changing during approval blocks recording", real, async t => {
  const f = await fixture(t);
  await f.approve();
  const head = await f.user();
  const result = await f.adopt(f.base, head, { confirm: async () => { await f.user("sneaky.txt"); return true; } });
  assert.equal(result.ok, false);
  assert.match(result.message, /Stale HEAD/);
  assert.equal((await f.feature()).history.length, 0);
  const second = await f.adopt(f.base, f.g("rev-parse", "HEAD"), { confirm: async () => { await writeFile(path.join(f.dir, "dirty.txt"), "x\n"); return true; } });
  assert.equal(second.ok, false);
  assert.match(second.message, /clean source tree/);
});

test("repeats, interruption and a lost response are safe", real, async t => {
  const f = await fixture(t);
  await f.approve();
  const head = await f.user();
  // Interrupted after the artifact is stored but before the entry: nothing is recorded; retry works.
  const crashed = await f.adopt(f.base, head, { interrupt: async point => { if (point === "afterArtifact") throw new Error("crash"); } });
  assert.equal(crashed.ok, false);
  assert.equal((await f.feature()).history.length, 0);
  // The entry is recorded but the response is lost.
  let approvals = 0;
  const lost = await f.adopt(f.base, head, {
    confirm: async () => { approvals++; return true; },
    interrupt: async point => { if (point === "afterRecord") throw new Error("response lost"); },
  });
  assert.equal(lost.ok, false);
  assert.equal((await f.feature()).history.length, 1);
  const retry = await f.adopt(f.base, head, { confirm: async () => { approvals++; return true; } });
  assert.equal(retry.ok, true);
  assert.equal(retry.recovered, true);
  assert.equal(approvals, 1); // the retry did not ask again
  // Even after unrelated progress the same approved request returns the same record.
  await f.user("progress.txt");
  await writeFile(path.join(f.dir, "dirty.txt"), "x\n");
  const later = await f.adopt(f.base, head);
  assert.equal(later.recovered, true);
  assert.equal((await f.feature()).history.length, 1);
});

test("concurrent recording yields exactly one entry", real, async t => {
  const f = await fixture(t);
  await f.approve();
  const head = await f.user();
  const results = await Promise.all(Array.from({ length: 4 }, () => f.adopt(f.base, head)));
  assert.ok(results.some(r => r.ok), JSON.stringify(results));
  assert.equal((await f.feature()).history.filter(s => s.kind === "foreign").length, 1);
  for (const r of results) if (!r.ok) assert.match(r.message, /recorded head|already|Scaffold refused/);
});

test("drift inspection is read-only and names the applicable recovery", real, async t => {
  const f = await fixture(t);
  await f.approve();
  assert.equal((await inspectDrift({ featureId: "F1" }, f.context)).state, "authenticated");
  await writeFile(path.join(f.dir, "dirty.txt"), "x\n");
  const dirty = await inspectDrift({ featureId: "F1" }, f.context);
  assert.equal(dirty.state, "dirty-worktree");
  await rm(path.join(f.dir, "dirty.txt"));
  f.g("switch", "-qc", "feature/else");
  assert.equal((await inspectDrift({ featureId: "F1" }, f.context)).state, "branch-mismatch");
  f.g("switch", "-q", "feature/ledger");
  f.g("commit", "-q", "--allow-empty", "--amend", "-m", "rewritten baseline");
  assert.equal((await inspectDrift({ featureId: "F1" }, f.context)).state, "rewritten-history");
  const missing = await inspectDrift({ featureId: "NOPE" }, f.context);
  assert.equal(missing.ok, false);
});

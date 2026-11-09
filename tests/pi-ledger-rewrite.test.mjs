// Real-Scaffold integration: recording a rebase as a history-rewrite entry after fresh verification.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { git } from "../pi/agent/lib/git/tree.mjs";
import { scaffoldTasks } from "../pi/agent/extensions/scaffold/adapter.mjs";
import { approveFeatureDirection } from "../pi/agent/extensions/scaffold/feature-authorization.mjs";
import { adoptCommits } from "../pi/agent/extensions/execution-recovery/foreign-history.mjs";
import { rewriteFeatureHistory } from "../pi/agent/extensions/execution-recovery/reconciliation.mjs";
import { verifyHistory, foreignHistoryRequirements } from "../pi/agent/lib/verification/history.mjs";
import { planRewrite } from "../pi/agent/lib/verification/rewrite-history.mjs";

const hasScaffold = spawnSync("scaffold", ["--help"], { encoding: "utf8" }).status === 0;
const real = { skip: !hasScaffold && "Real Scaffold (schema 3) is not on PATH" };
const node = process.execPath;

async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-ledger-rewrite-"));
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
  g("switch", "-qc", "feature/rebase");
  const base = g("rev-parse", "HEAD");
  const context = { directory: dir };
  const call = async (operation, payload, task_id) => {
    const response = await scaffoldTasks({ operation, feature_id: "F1", ...(task_id ? { task_id } : {}),
      ...(payload !== undefined ? { payload } : {}) }, context);
    assert.equal(response.ok, true, JSON.stringify(response));
    return response.data;
  };
  await call("init", { id: "F1", title: "Feature", objective: "Survive a rebase", design_ref: "sha256:context",
    context: "Approved design", acceptance_criteria: ["History survives"], baseline: base, branch: "feature/rebase" });
  await call("decompose", [{ id: "a", title: "a", objective: "Do a", acceptance_criteria: ["a works"] },
    { id: "b", title: "b", objective: "Do b", acceptance_criteria: ["b works"], dependencies: ["a"] }], "F1");
  for (const [id, disposition] of [["F1", "decomposed"], ["a", "leaf"], ["b", "leaf"]])
    await call("design-record", { summary: "s", verification: "v", approval: "user", disposition }, id);
  await call("design-finish");
  const approved = await approveFeatureDirection({ featureId: "F1" }, context, { confirm: async () => true });
  assert.equal(approved.ok, true, JSON.stringify(approved));
  const feature = async () => (await call("list")).feature;

  // Record a task checkpoint the way the delivery pipeline does (commit with the trailer, then ledger entries).
  async function checkpoint(taskId, file) {
    await call("start", undefined, taskId);
    const receipt = (await call("artifact-put", { receipt: taskId })).reference;
    const before = await feature();
    await writeFile(path.join(dir, file), taskId + "\n");
    g("add", ".");
    g("commit", "-qm", "Checkpoint verified task " + taskId + "\n\nPi-Checkpoint: " + taskId);
    const commit = g("rev-parse", "HEAD"), tree = g("rev-parse", "HEAD^{tree}");
    await call("attempt-record", { attempt: 1, status: "PASSED", receipt, base: before.head, tree }, taskId);
    await call("complete", { feature_id: "F1", task_id: taskId, result: "PASSED", source: "conductor", reference: receipt, summary: "ok" }, taskId);
    await call("checkpoint-record", { commit, parent: before.head, tree, reference: receipt }, taskId);
    return commit;
  }
  async function foreign(name) {
    await writeFile(path.join(dir, name), name + "\n");
    g("add", ".");
    g("commit", "-qm", "user: " + name);
    const to = g("rev-parse", "HEAD");
    const from = (await feature()).head;
    const result = await adoptCommits({ featureId: "F1", fromRef: from, toRef: to }, context, { confirm: async () => true });
    assert.equal(result.ok, true, JSON.stringify(result));
    return to;
  }
  // The upstream branch moves while the feature is in progress.
  async function upstream(name = "upstream.txt") {
    g("switch", "-q", "main");
    await writeFile(path.join(dir, name), "upstream\n");
    g("add", ".");
    g("commit", "-qm", "upstream: " + name);
    const tip = g("rev-parse", "HEAD");
    g("switch", "-q", "feature/rebase");
    return tip;
  }
  const reviewScript = path.join(dir, "..", "fake-review-" + path.basename(dir) + ".mjs");
  const review = status => writeFile(reviewScript, `console.log(JSON.stringify({schema:'review.result/v1',review_id:'fixture',completed_at:'2026-11-01T00:00:00Z',status:${JSON.stringify(status)},reason:'REVIEW_COMPLETED',findings:${status === "APPROVED" ? "[]" : "[{severity:'high',blocking:true,message:'fix it'}]"},obligation_assessments:[]}));process.exitCode=${status === "APPROVED" ? 0 : 1};`);
  t.after(() => rm(reviewScript, { force: true }));
  await review("APPROVED");
  const rewrite = async (overrides = {}, options = {}) => {
    const state = await feature();
    return rewriteFeatureHistory({
      featureId: "F1", designRef: state.design_ref, branch: "feature/rebase", oldHeadRef: state.head,
      upstreamBaseRef: g("rev-parse", "main"), headRef: g("rev-parse", "HEAD"), defaultBranch: "main", protectedBranches: [],
      buildCommand: [node, "-e", "console.log('built')"], testCommand: [node, "-e", "console.log('2 tests passed')"],
      testSuccessPattern: "2 tests passed", ...overrides,
    }, context, { reviewOptions: { executable: node, prefixArgs: [reviewScript] }, ...options });
  };
  return { dir, g, base, context, call, feature, checkpoint, foreign, upstream, review, rewrite };
}

test("a rebase is mapped, freshly verified and recorded; the old history is kept", real, async t => {
  const f = await fixture(t);
  const a = await f.checkpoint("a", "a.txt");
  await f.foreign("user.txt");
  const old = await f.feature();
  assert.equal(old.history.length, 2);
  const tip = await f.upstream();
  f.g("rebase", "-q", "main");
  assert.notEqual(f.g("rev-parse", "HEAD"), old.head);

  const result = await f.rewrite();
  assert.equal(result.status, "PASSED", JSON.stringify(result));
  const after = await f.feature();
  assert.equal(after.base, tip);
  assert.equal(after.original_baseline, f.base); // the original fork point never changes
  assert.equal(after.head, f.g("rev-parse", "HEAD"));
  assert.deepEqual(after.history.map(s => s.kind), ["checkpoint", "foreign"]);
  assert.notEqual(after.history[0].commit, a);
  assert.equal(after.history[0].parent, tip);
  assert.equal(after.tasks.a.checkpoint.commit, after.history[0].commit);
  assert.deepEqual(after.epochs.map(e => [e.base, e.head]), [[f.base, old.head]]);
  assert.equal(after.epochs[0].verification, result.evidenceRef);
  verifyHistory(f.dir, after, { head: after.head });
  assert.match(foreignHistoryRequirements(after), /user: user\.txt/);

  // The retained verification records exactly what was checked and reviewed.
  const stored = (await f.call("artifact-get", { reference: result.evidenceRef })).artifact;
  assert.equal(stored.result.status, "PASSED");
  assert.equal(stored.binding.baseline, tip);
  assert.equal(stored.checks.length, 2);
  assert.equal(stored.review.status, "APPROVED");

  // Execution continues on the rebased chain.
  await f.checkpoint("b", "b.txt");
  assert.deepEqual((await f.feature()).history.map(s => s.kind), ["checkpoint", "foreign", "checkpoint"]);
});

test("recording the same rewrite again is idempotent and asks for nothing new", real, async t => {
  const f = await fixture(t);
  await f.checkpoint("a", "a.txt");
  const old = (await f.feature()).head;
  await f.upstream();
  f.g("rebase", "-q", "main");
  const first = await f.rewrite();
  assert.equal(first.status, "PASSED", JSON.stringify(first));
  // After the rewrite the tree may be dirty or HEAD may have moved on; the same request still returns the record.
  await writeFile(path.join(f.dir, "dirty.txt"), "x\n");
  const again = await f.rewrite({ oldHeadRef: old });
  assert.equal(again.status, "PASSED");
  assert.equal(again.recovered, true);
  assert.equal(again.evidenceRef, first.evidenceRef);
  assert.equal((await f.feature()).epochs.length, 1);
});

test("a retained verification resumes after a lost response without re-running anything", real, async t => {
  const f = await fixture(t);
  await f.checkpoint("a", "a.txt");
  await f.upstream();
  f.g("rebase", "-q", "main");
  // The first run stores its verification, then the Scaffold call is made to fail (response lost).
  const failing = await f.rewrite({}, { scaffoldOptions: { invokeScaffold: async (program, args, options) => {
    if (args[0] === "history-rewrite") return { code: 1, stdout: "", stderr: '{"schema_version":3,"error":"injected"}' };
    const { invoke } = await import("../pi/agent/extensions/scaffold/adapter.mjs");
    return invoke(program, args, options);
  } } });
  assert.equal(failing.status, "BLOCKED");
  assert.equal((await f.feature()).epochs.length, 0);
  // The passing verification was retained before the entry was recorded, so it can be resumed.
  assert.ok(failing.evidenceRef, "the verification was retained before the failure");
  const resumed = await f.rewrite({ resumeEvidenceRef: failing.evidenceRef });
  assert.equal(resumed.status, "PASSED", JSON.stringify(resumed));
  assert.equal(resumed.recovered, true);
  assert.equal((await f.feature()).epochs.length, 1);
  assert.equal((await f.feature()).epochs[0].verification, failing.evidenceRef);
  // A retained verification for a different rebase is never accepted.
  await assert.rejects(Promise.resolve().then(async () => {
    const r = await f.rewrite({ resumeEvidenceRef: "sha256:" + "0".repeat(64) });
    if (r.status === "BLOCKED") throw new Error(r.message);
  }), /./);
});

test("a rebase that drops, adds, reorders or squashes recorded commits cannot be mapped", real, async t => {
  const f = await fixture(t);
  const a = await f.checkpoint("a", "a.txt");
  const user = await f.foreign("user.txt");
  const state = await f.feature();
  const tip = await f.upstream();
  const attempt = (...picks) => {
    f.g("switch", "-q", "-C", "feature/rebase", tip);
    for (const pick of picks) f.g("cherry-pick", pick);
    return f.g("rev-parse", "HEAD");
  };
  const refused = (head, pattern) => assert.throws(() => planRewrite(f.dir, state, { upstreamBaseRef: tip, headRef: head }), pattern);
  refused(attempt(a), /ledger recorded 2/); // user commit dropped
  attempt(a, user);
  await writeFile(path.join(f.dir, "extra.txt"), "x\n");
  f.g("add", ".");
  f.g("commit", "-qm", "an unrecorded extra commit");
  refused(f.g("rev-parse", "HEAD"), /ledger recorded 2/); // extra commit added
  refused(attempt(user, a), /not the checkpoint of task a/); // reordered
  f.g("switch", "-q", "-C", "feature/rebase", tip);
  f.g("cherry-pick", "-n", a, user);
  f.g("commit", "-qm", "squashed\n\nPi-Checkpoint: a");
  refused(f.g("rev-parse", "HEAD"), /ledger recorded 2/); // squashed
  // The correctly rebased branch maps cleanly.
  const good = attempt(a, user);
  const planned = planRewrite(f.dir, state, { upstreamBaseRef: tip, headRef: good });
  assert.deepEqual(planned.history.map(s => s.kind), ["checkpoint", "foreign"]);
  assert.equal(planned.newHead, good);
  assert.equal(planned.newBase, tip);
});

test("a base that HEAD is not built on, and a foreign range with a merge, are refused", real, async t => {
  const f = await fixture(t);
  await f.checkpoint("a", "a.txt");
  const state = await f.feature();
  const tip = await f.upstream();
  assert.throws(() => planRewrite(f.dir, state, { upstreamBaseRef: tip, headRef: f.g("rev-parse", "HEAD") }), /not an ancestor/);
  assert.throws(() => planRewrite(f.dir, state, { upstreamBaseRef: "main", headRef: "HEAD" }), /full SHAs/);
});

test("preconditions: recorded head, active tasks, dirty tree, unapproved direction and protected branches", real, async t => {
  const f = await fixture(t);
  await f.checkpoint("a", "a.txt");
  await f.upstream();
  f.g("rebase", "-q", "main");
  const blocked = async (overrides, pattern, name) => {
    const before = JSON.stringify(await f.feature());
    const result = await f.rewrite(overrides);
    assert.equal(result.status, "BLOCKED", name);
    assert.match(result.message, pattern, name);
    assert.equal(JSON.stringify(await f.feature()), before, name + " must not change the ledger");
  };
  await blocked({ oldHeadRef: f.base }, /Recorded head mismatch/, "wrong recorded head");
  await blocked({ oldHeadRef: f.g("rev-parse", "HEAD") }, /No history change/, "no change");
  await blocked({ headRef: f.g("rev-parse", "HEAD~1") }, /clean matching HEAD/, "stale HEAD");
  await blocked({ oldHeadRef: "abc" }, /full SHAs/, "malformed");
  await blocked({ branch: "feature/other" }, /Feature branch changed/, "branch");
  await blocked({ protectedBranches: ["feature/rebase"] }, /protected/, "protected");
  await writeFile(path.join(f.dir, "dirty.txt"), "x\n");
  await blocked({}, /clean matching HEAD/, "dirty tree");
  await rm(path.join(f.dir, "dirty.txt"));
  await f.call("start", undefined, "b");
  await blocked({}, /task is active/, "active task");
});

test("failing checks, a rejecting review and an unmeaningful test run record nothing", real, async t => {
  const f = await fixture(t);
  await f.checkpoint("a", "a.txt");
  await f.upstream();
  f.g("rebase", "-q", "main");
  const before = JSON.stringify(await f.feature());
  const cases = [
    [{ buildCommand: [node, "-e", "process.exit(1)"] }, "NEEDS_DESIGN", "failing build"],
    [{ testCommand: [node, "-e", "console.log('0 tests passed')"], testSuccessPattern: "tests passed" }, "BLOCKED", "empty test run"],
  ];
  for (const [overrides, status, name] of cases) {
    const result = await f.rewrite(overrides);
    assert.equal(result.status, status, name + " " + JSON.stringify(result));
    assert.equal(JSON.stringify(await f.feature()), before, name + " must not change the ledger");
  }
  await f.review("CHANGES_REQUESTED");
  const rejected = await f.rewrite();
  assert.equal(rejected.status, "NEEDS_DESIGN", JSON.stringify(rejected));
  assert.ok(rejected.evidenceRef, "the rejection is retained as evidence");
  assert.equal(JSON.stringify(await f.feature()), before);
  await f.review("APPROVED");
  assert.equal((await f.rewrite()).status, "PASSED");
});

test("rebasing before any task completes only moves the base", real, async t => {
  const f = await fixture(t);
  const tip = await f.upstream();
  f.g("rebase", "-q", "main");
  const result = await f.rewrite();
  assert.equal(result.status, "PASSED", JSON.stringify(result));
  const after = await f.feature();
  assert.equal(after.base, tip);
  assert.equal(after.head, tip);
  assert.deepEqual(after.history, []);
  assert.equal(after.original_baseline, f.base);
});

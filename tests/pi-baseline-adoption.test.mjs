import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { git } from "../pi/agent/lib/git/tree.mjs";
import { designReference } from "../pi/agent/lib/scaffold/contracts.mjs";
import { approveFeatureDirection } from "../pi/agent/lib/authorization/feature.mjs";
import { adoptFeatureBaseline, findAdoption, executionBaseline, adoptionRequirements } from "../pi/agent/lib/verification/baseline-adoption.mjs";
import { checkpointHistory } from "../pi/agent/lib/verification/checkpoint-history.mjs";
import { inspectFeatureDrift } from "../pi/agent/lib/verification/drift.mjs";
import { retainEvidence } from "../pi/agent/lib/evidence/store.mjs";

export async function fixture(t, { authorize = true } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-adoption-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const g = (...args) => git(dir, args);
  g("init", "-q", "-b", "main");
  g("config", "user.name", "Test"); g("config", "user.email", "test@example.invalid");
  g("config", "core.autocrlf", "false"); g("config", "core.excludesfile", "");
  await writeFile(path.join(dir, ".gitignore"), ".scaffold/\n");
  await writeFile(path.join(dir, "value.txt"), "before\n");
  g("add", "."); g("commit", "-qm", "baseline");
  g("switch", "-qc", "feature/adopt");
  const base = g("rev-parse", "HEAD");
  const feature = { id: "F", context: "Approved design", design_ref: designReference("Approved design"),
    objective: "Objective", acceptance_criteria: ["Criterion"], constraints: ["Constraint"],
    baseline: base, original_baseline: base, branch: "feature/adopt", task_revision: 3,
    workflow: { kind: "recursive-issues/v1", phase: "implement", root_id: "root", instance_id: "a".repeat(32) },
    tasks: { root: { id: "root", status: "decomposed", dependencies: [] }, one: { id: "one", status: "pending", parent_id: "root", dependencies: [] } } };
  const context = { directory: dir };
  if (authorize) {
    const approved = await approveFeatureDirection({ featureId: "F" }, { feature, tasks: feature.tasks }, context,
      { confirmFeature: async () => structuredClone(feature) });
    assert.equal(approved.ok, true, approved.message);
  }
  const userCommit = async (name = "user.txt") => {
    await writeFile(path.join(dir, name), name + "\n"); g("add", "."); g("commit", "-qm", "user: " + name); return g("rev-parse", "HEAD");
  };
  const args = head => ({ featureId: "F", originalBaseRef: base, newBaseRef: head });
  const adopt = (head, options = {}, overrides = {}) => adoptFeatureBaseline({ ...args(head), ...overrides },
    { readFeature: async () => structuredClone(feature) }, context, { confirm: async () => true, ...options });
  return { dir, g, base, feature, context, userCommit, adopt, args };
}
const snapshotRefs = f => f.g("for-each-ref", "refs/pi-baseline-adoptions");
const noMutation = async (f, fn) => {
  const before = [snapshotRefs(f), f.g("rev-parse", "HEAD"), f.g("status", "--porcelain")];
  const result = await fn();
  assert.deepEqual([snapshotRefs(f), f.g("rev-parse", "HEAD"), f.g("status", "--porcelain")], before);
  return result;
};

test("adoption records a distinct execution baseline, preserves the original and authenticates an empty checkpoint prefix", async t => {
  const f = await fixture(t);
  const head = await f.userCommit();
  await assert.rejects(checkpointHistory(f.dir, f.feature, { head, baseline: f.base, branch: f.feature.branch }), /Unrelated or duplicate/);
  let shown;
  const result = await f.adopt(head, { confirm: async scope => { shown = scope; return true; } });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.originalBaseline, f.base); assert.equal(result.adoptedBaseline, head);
  assert.deepEqual(shown.commits.map(c => c.commit), [head]); assert.deepEqual(shown.changedPaths, ["user.txt"]);
  const adoption = await findAdoption(f.dir, f.feature);
  assert.equal(adoption.reference, result.reference);
  assert.equal(await executionBaseline(f.dir, f.feature), head);
  assert.equal(f.feature.original_baseline, f.base);
  assert.deepEqual(await checkpointHistory(f.dir, f.feature, { head, baseline: f.base, branch: f.feature.branch }), []);
  assert.match(adoptionRequirements(adoption), /NOT task checkpoints[\s\S]*user: user\.txt[\s\S]*user\.txt/);
  // A later foreign commit is still not authenticated.
  const later = await f.userCommit("later.txt");
  await assert.rejects(checkpointHistory(f.dir, f.feature, { head: later, baseline: f.base, branch: f.feature.branch }), /Unrelated or duplicate/);
  assert.equal((await inspectFeatureDrift(f.dir, f.feature, f.context)).state, "foreign-commits");
});

test("explicit approval bound to both commits is mandatory and never implied", async t => {
  const f = await fixture(t);
  const head = await f.userCommit();
  for (const confirm of [undefined, async () => false, async () => "yes", async () => ({ approved: true })]) {
    const r = await noMutation(f, () => f.adopt(head, { confirm }));
    assert.equal(r.ok, false); assert.match(r.message, /Explicit user approval/);
  }
  assert.equal(await findAdoption(f.dir, f.feature), null);
  // Feature-direction authorization is not adoption approval, and it is retained untouched.
  assert.equal((await f.adopt(head)).ok, true);
});

test("ineligible or stale state is rejected without mutation", async t => {
  const f = await fixture(t);
  const head = await f.userCommit();
  const cases = [
    ["stale HEAD", () => f.adopt(head, {}, { newBaseRef: f.base }), /Stale HEAD|already equals/],
    ["wrong original", () => f.adopt(head, {}, { originalBaseRef: head }), /Original baseline mismatch/],
    ["malformed SHA", () => f.adopt(head, {}, { newBaseRef: "HEAD" }), /full SHAs/],
    ["unknown feature", () => f.adopt(head, {}, { featureId: "other" }), /Cannot inspect feature/],
  ];
  for (const [name, run, pattern] of cases) {
    const r = await noMutation(f, run); assert.equal(r.ok, false, name); assert.match(r.message, pattern, name);
  }
  await writeFile(path.join(f.dir, "dirty.txt"), "x\n");
  let r = await noMutation(f, () => f.adopt(head)); assert.match(r.message, /clean source tree/);
  f.g("add", "dirty.txt"); r = await noMutation(f, () => f.adopt(head)); assert.match(r.message, /clean source tree/);
  f.g("reset", "-q"); await rm(path.join(f.dir, "dirty.txt"));
  f.g("switch", "-qc", "feature/other"); r = await noMutation(f, () => f.adopt(head)); assert.match(r.message, /Branch mismatch/);
  f.g("switch", "-q", "feature/adopt");
  f.g("checkout", "-q", "--detach"); r = await noMutation(f, () => f.adopt(head)); assert.equal(r.ok, false);
  f.g("switch", "-q", "feature/adopt");
  const changed = { ...f.feature, id: "F", workflow: { ...f.feature.workflow, instance_id: "b".repeat(32) } };
  r = await noMutation(f, () => adoptFeatureBaseline(f.args(head), { readFeature: async () => changed }, f.context, { confirm: async () => true }));
  assert.match(r.message, /authorization is missing/);
  f.g("reset", "-q", "--hard", f.base); f.g("commit", "--amend", "-qm", "rewritten baseline");
  r = await noMutation(f, () => f.adopt(f.g("rev-parse", "HEAD"))); assert.match(r.message, /not an ancestor/);
  assert.equal(await findAdoption(f.dir, f.feature), null);
});

test("missing authority and started features are rejected", async t => {
  const none = await fixture(t, { authorize: false });
  const head = await none.userCommit();
  const r = await noMutation(none, () => none.adopt(head)); assert.match(r.message, /authorization is missing/);
  for (const [name, mutate, pattern] of [
    ["completed task", feature => { feature.tasks.one.status = "completed"; }, /Task one is completed/],
    ["in progress", feature => { feature.tasks.one.status = "in_progress"; }, /in_progress/],
    ["delivery state", feature => { feature.tasks.one.delivery = { head: "x" }; }, /delivery state/],
    ["suspension", feature => { feature.tasks.one.suspension = { reference: "x" }; }, /suspended/],
  ]) {
    const f = await fixture(t); const h = await f.userCommit(); mutate(f.feature);
    const result = await noMutation(f, () => f.adopt(h)); assert.equal(result.ok, false, name); assert.match(result.message, pattern, name);
  }
});

test("consumed attempt evidence for this feature instance blocks adoption; other instances do not", async t => {
  const f = await fixture(t);
  const head = await f.userCommit();
  const receipt = instance => retainEvidence(f.dir, { repository: f.dir, task: { featureId: "F", taskId: "one", designRef: f.feature.design_ref },
    featureInstanceId: instance, attempt: 1 });
  await receipt("c".repeat(32)); // a previous incarnation of the same feature id
  const ok = await f.adopt(head); assert.equal(ok.ok, true, JSON.stringify(ok));
  const g = await fixture(t);
  const next = await g.userCommit();
  await retainEvidence(g.dir, { repository: g.dir, task: { featureId: "F", taskId: "one", designRef: g.feature.design_ref },
    featureInstanceId: g.feature.workflow.instance_id, attempt: 1 });
  const blocked = await noMutation(g, () => g.adopt(next));
  assert.equal(blocked.ok, false); assert.match(blocked.message, /attempt evidence exists/);
});

test("intervening task checkpoint commits make the range ineligible", async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.dir, "v.txt"), "1\n"); f.g("add", "."); f.g("commit", "-qm", "Checkpoint\n\nPi-Task-Checkpoint: {}");
  const r = await f.adopt(f.g("rev-parse", "HEAD")); assert.equal(r.ok, false); assert.match(r.message, /checkpoint commits/);
});

test("repeat, lost-response retry and later retry after progress are idempotent", async t => {
  const f = await fixture(t);
  const head = await f.userCommit();
  let approvals = 0;
  const lost = await f.adopt(head, { confirm: async () => { approvals++; return true; }, interrupt: async point => { if (point === "afterRetention") throw new Error("response lost"); } });
  assert.equal(lost.ok, false); assert.match(lost.message, /response lost/);
  const found = await findAdoption(f.dir, f.feature);
  assert.ok(found, "retention committed before the response was lost");
  const retry = await f.adopt(head, { confirm: async () => { approvals++; return true; } });
  assert.equal(retry.ok, true); assert.equal(retry.recovered, true); assert.equal(retry.reference, found.reference); assert.equal(approvals, 1);
  // Even after unrelated progress (HEAD moved, tree dirty) the same approved request returns the same record.
  await f.userCommit("progress.txt"); await writeFile(path.join(f.dir, "dirty.txt"), "x\n");
  const again = await f.adopt(head); assert.equal(again.recovered, true); assert.equal(again.reference, found.reference);
  const different = await f.adopt(f.g("rev-parse", "HEAD")); assert.equal(different.ok, false); assert.match(different.message, /different baseline is already adopted/);
});

test("interrupted persistence leaves no authority and can be retried", async t => {
  const f = await fixture(t);
  const head = await f.userCommit();
  const interrupted = await f.adopt(head, { interrupt: async point => { if (point === "afterRecord") throw new Error("crash"); } });
  assert.equal(interrupted.ok, false);
  assert.equal(await findAdoption(f.dir, f.feature), null);
  assert.equal(snapshotRefs(f), "");
  await assert.rejects(checkpointHistory(f.dir, f.feature, { head, baseline: f.base, branch: f.feature.branch }), /Unrelated/);
  const done = await f.adopt(head); assert.equal(done.ok, true);
  assert.equal((await findAdoption(f.dir, f.feature)).reference, done.reference);
});

test("concurrent adoption has exactly one winner and identical results", async t => {
  const f = await fixture(t);
  const head = await f.userCommit();
  const results = await Promise.all(Array.from({ length: 6 }, () => f.adopt(head)));
  assert.ok(results.every(r => r.ok), JSON.stringify(results));
  assert.equal(new Set(results.map(r => r.reference)).size, 1);
  assert.equal(results.filter(r => !r.recovered).length, 1);
  assert.equal(f.g("for-each-ref", "refs/pi-baseline-adoptions").split("\n").length, 3);
});

test("state changing during approval blocks adoption", async t => {
  const f = await fixture(t);
  const head = await f.userCommit();
  let r = await f.adopt(head, { confirm: async () => { await f.userCommit("sneaky.txt"); return true; } });
  assert.equal(r.ok, false); assert.match(r.message, /Stale HEAD/);
  r = await f.adopt(f.g("rev-parse", "HEAD"), { confirm: async () => { await writeFile(path.join(f.dir, "dirty.txt"), "x\n"); return true; } });
  assert.equal(r.ok, false); assert.match(r.message, /clean source tree/);
  assert.equal(await findAdoption(f.dir, f.feature), null);
});

test("corrupt, tampered or foreign adoption evidence fails closed", async t => {
  const f = await fixture(t);
  const head = await f.userCommit();
  assert.equal((await f.adopt(head)).ok, true);
  const rewritten = { ...f.feature, workflow: { ...f.feature.workflow, instance_id: "d".repeat(32) } };
  assert.equal(await findAdoption(f.dir, rewritten), null); // a recreated instance never inherits the adoption
  for (const mutate of [{ design_ref: "sha256:" + "e".repeat(64) }, { original_baseline: head }]) {
    await assert.rejects(findAdoption(f.dir, { ...f.feature, ...mutate }), /different feature identity|Adopted baseline does not descend|authorization/);
  }
  const prefix = f.g("for-each-ref", "--format=%(refname)", "refs/pi-baseline-adoptions").split("\n").find(x => x.endsWith("/adopted"));
  f.g("update-ref", prefix, f.base);
  await assert.rejects(findAdoption(f.dir, f.feature), /refs are missing or changed/);
  assert.equal((await inspectFeatureDrift(f.dir, f.feature, f.context)).state, "corrupt-adoption-evidence");
  f.g("update-ref", "-d", prefix);
  await assert.rejects(findAdoption(f.dir, f.feature), /refs are missing or changed/);
});

test("adoption cannot be combined with a rebase anchor", async t => {
  const f = await fixture(t);
  const head = await f.userCommit();
  await f.adopt(head);
  await assert.rejects(checkpointHistory(f.dir, f.feature, { head, baseline: f.base, branch: f.feature.branch,
    anchor: { head, tasks: {}, checkpoints: [], reference: "x" } }), /cannot be combined with rebase/);
});

test("drift inspection is read-only and names the applicable recovery", async t => {
  const f = await fixture(t);
  assert.equal((await inspectFeatureDrift(f.dir, f.feature, f.context)).state, "authenticated");
  const head = await f.userCommit();
  await writeFile(path.join(f.dir, "dirty.txt"), "x\n");
  const dirty = await noMutation(f, () => inspectFeatureDrift(f.dir, f.feature, f.context));
  assert.equal(dirty.state, "dirty-worktree"); await rm(path.join(f.dir, "dirty.txt"));
  const foreign = await noMutation(f, () => inspectFeatureDrift(f.dir, f.feature, f.context));
  assert.equal(foreign.state, "foreign-commits"); assert.match(foreign.recommendation, /adopt_feature_baseline/);
  assert.equal(foreign.details.adoptionEligible, true);
  const started = structuredClone(f.feature); started.tasks.one.status = "completed";
  const blocked = await inspectFeatureDrift(f.dir, started, f.context);
  assert.equal(blocked.details.adoptionEligible, false); assert.match(blocked.recommendation, /not supported yet/);
  f.g("reset", "-q", "--hard", f.base); f.g("commit", "--amend", "-qm", "alt baseline");
  assert.equal((await inspectFeatureDrift(f.dir, f.feature, f.context)).state, "rewritten-history");
  f.g("switch", "-qc", "feature/else");
  assert.equal((await inspectFeatureDrift(f.dir, f.feature, f.context)).state, "branch-mismatch");
  void head;
});

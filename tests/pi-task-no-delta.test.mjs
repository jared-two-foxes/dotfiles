import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { taskHasNoDelta, NO_DELTA_REVIEW_NOTE } from "../pi/agent/lib/verification/no-delta.mjs";
import { reviewHandoff } from "../pi/agent/lib/verification/review-evidence.mjs";

const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();

test("a task whose tree equals its base tree has no delta of its own", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "no-delta-"));
  try {
    git(dir, "init", "-q");
    await writeFile(path.join(dir, "a.txt"), "one");
    git(dir, "add", "-A"); git(dir, "commit", "-qm", "base");
    const base = git(dir, "rev-parse", "HEAD");
    const tree = git(dir, "rev-parse", "HEAD^{tree}");
    assert.equal(taskHasNoDelta(dir, base, tree), true);
    await writeFile(path.join(dir, "a.txt"), "two");
    git(dir, "add", "-A");
    const changed = git(dir, "write-tree");
    assert.equal(taskHasNoDelta(dir, base, changed), false);
    assert.equal(taskHasNoDelta(dir, "0".repeat(40), tree), false); // unknown base never counts as no-delta
    assert.equal(taskHasNoDelta(dir, base, undefined), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("review handoff tells the reviewer an empty diff is expected only for no-delta tasks", () => {
  const out = path.resolve("out");
  const last = { args: ["guard", JSON.stringify({ args: [path.join(out, "review.json")], inputs: [] })] };
  const workflow = { request: { output_directory: out, commands: [last] }, inputs: { requirements: "REQS", review: { schema: "review.request/v1" } } };
  const evidence = { schema: "pi.task-review-evidence/v1", checks: [] };
  const plain = reviewHandoff(workflow, evidence).files[1][1];
  const noDelta = reviewHandoff(workflow, evidence, { noDelta: true }).files[1][1];
  assert.ok(!plain.includes(NO_DELTA_REVIEW_NOTE));
  assert.ok(noDelta.includes(NO_DELTA_REVIEW_NOTE));
});

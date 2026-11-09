import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createPreconditionCache,
  evidenceFingerprint,
  memoizePreconditions,
  preconditionCacheStats,
} from "../pi/agent/lib/verification/precondition-cache.mjs";
import { featureTimings } from "../pi/agent/lib/verification/timings.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function repository(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-precondition-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", dir]);
  const evidence = path.join(dir, ".git", "pi-conductor-evidence");
  return { dir, evidence, create: () => mkdir(evidence) };
}

test("evidence fingerprint is stable until a file is added, removed, renamed or edited", async (t) => {
  const r = await repository(t);
  assert.equal(await evidenceFingerprint(r.dir), "absent");
  await r.create();
  const empty = await evidenceFingerprint(r.dir);
  assert.equal(await evidenceFingerprint(r.dir), empty, "untouched directory is stable");

  const one = path.join(r.evidence, "a".repeat(64) + ".json");
  await writeFile(one, '{"v":1}');
  const withOne = await evidenceFingerprint(r.dir);
  assert.notEqual(withOne, empty, "added file");
  assert.equal(await evidenceFingerprint(r.dir), withOne);

  await sleep(20);
  await writeFile(one, '{"v":2}'); // same size, different content
  const edited = await evidenceFingerprint(r.dir);
  assert.notEqual(edited, withOne, "in-place edit of the same size");

  const second = path.join(r.evidence, "b".repeat(64) + ".json");
  await rename(one, second);
  const renamed = await evidenceFingerprint(r.dir);
  assert.notEqual(renamed, edited, "rename");

  await rm(second);
  assert.equal(await evidenceFingerprint(r.dir), empty, "removal returns to the empty directory");
});

test("an edit that restores the file's modification time is still detected", async (t) => {
  const r = await repository(t);
  await r.create();
  const file = path.join(r.evidence, "c".repeat(64) + ".json");
  const fixed = 1_700_000_000; // whole seconds, so the restored mtime is bit-for-bit identical
  await writeFile(file, '{"v":1}');
  await utimes(file, fixed, fixed);
  const before = await evidenceFingerprint(r.dir);
  const first = await stat(file);
  await sleep(20);
  await writeFile(file, '{"v":2}'); // same size, same inode
  await utimes(file, fixed, fixed); // put mtime back exactly; ctime cannot be restored
  const second = await stat(file);
  assert.equal(second.mtimeMs, first.mtimeMs, "test premise: mtime is identical");
  assert.equal(second.size, first.size);
  assert.equal(second.ino, first.ino);
  assert.notEqual(await evidenceFingerprint(r.dir), before);
});

function counter(value = { tasks: ["one"] }) {
  const state = { calls: 0 };
  return { state, compute: async () => { state.calls += 1; return structuredClone(value); } };
}

test("without a cache every call computes", async (t) => {
  const r = await repository(t);
  const { state, compute } = counter();
  await memoizePreconditions(undefined, r.dir, ["k"], compute);
  await memoizePreconditions(undefined, r.dir, ["k"], compute);
  assert.equal(state.calls, 2);
  assert.equal(preconditionCacheStats(undefined), null);
});

test("an unchanged key and evidence directory reuse the earlier result", async (t) => {
  const r = await repository(t);
  const cache = createPreconditionCache();
  const { state, compute } = counter();
  const first = await memoizePreconditions(cache, r.dir, ["k"], compute);
  const second = await memoizePreconditions(cache, r.dir, ["k"], compute);
  assert.equal(state.calls, 1);
  assert.deepEqual(second, first);
  assert.deepEqual(preconditionCacheStats(cache), { hits: 1, misses: 1, fresh: 0 });
});

test("a changed key part or changed evidence forces a recompute", async (t) => {
  const r = await repository(t);
  await r.create();
  const cache = createPreconditionCache();
  const { state, compute } = counter();
  await memoizePreconditions(cache, r.dir, ["k", { tasks: 1 }], compute);
  await memoizePreconditions(cache, r.dir, ["k", { tasks: 2 }], compute); // feature state changed
  assert.equal(state.calls, 2);
  await memoizePreconditions(cache, r.dir, ["k", { tasks: 2 }], compute);
  assert.equal(state.calls, 2, "same key again is a hit");

  await writeFile(path.join(r.evidence, "d".repeat(64) + ".json"), "{}");
  await memoizePreconditions(cache, r.dir, ["k", { tasks: 2 }], compute); // evidence added
  assert.equal(state.calls, 3);
  await memoizePreconditions(cache, r.dir, ["k", { tasks: 2 }], compute);
  assert.equal(state.calls, 3, "and it is reusable again afterwards");
});

test("fresh always recomputes and refreshes the entry", async (t) => {
  const r = await repository(t);
  const cache = createPreconditionCache();
  const { state, compute } = counter();
  await memoizePreconditions(cache, r.dir, ["k"], compute);
  await memoizePreconditions(cache, r.dir, ["k"], compute, { fresh: true });
  assert.equal(state.calls, 2, "a cached entry never satisfies a fresh request");
  await memoizePreconditions(cache, r.dir, ["k"], compute);
  assert.equal(state.calls, 2, "the fresh result is stored for later reuse");
  assert.deepEqual(preconditionCacheStats(cache), { hits: 1, misses: 1, fresh: 1 });
});

test("failures are never cached", async (t) => {
  const r = await repository(t);
  const cache = createPreconditionCache();
  let calls = 0;
  const flaky = async () => {
    calls += 1;
    if (calls === 1) throw new Error("Evidence digest mismatch");
    return { ok: true };
  };
  await assert.rejects(memoizePreconditions(cache, r.dir, ["k"], flaky), /digest mismatch/);
  assert.deepEqual(await memoizePreconditions(cache, r.dir, ["k"], flaky), { ok: true });
  assert.equal(calls, 2);
  await memoizePreconditions(cache, r.dir, ["k"], flaky);
  assert.equal(calls, 2);
});

test("callers cannot corrupt a cached result by mutating what they were given", async (t) => {
  const r = await repository(t);
  const cache = createPreconditionCache();
  const { compute } = counter({ tasks: { one: { status: "completed" } } });
  const first = await memoizePreconditions(cache, r.dir, ["k"], compute);
  first.tasks.one.status = "mutated";
  const hit = await memoizePreconditions(cache, r.dir, ["k"], compute);
  assert.equal(hit.tasks.one.status, "completed");
  hit.tasks.one.status = "mutated again";
  assert.equal((await memoizePreconditions(cache, r.dir, ["k"], compute)).tasks.one.status, "completed");
});

test("a result computed while evidence changed is returned but never reused", async (t) => {
  const r = await repository(t);
  await r.create();
  const cache = createPreconditionCache();
  let calls = 0;
  const racing = async () => {
    calls += 1;
    await writeFile(path.join(r.evidence, `${calls}`.repeat(64) + ".json"), "{}");
    return { calls };
  };
  assert.deepEqual(await memoizePreconditions(cache, r.dir, ["k"], racing), { calls: 1 });
  assert.deepEqual(await memoizePreconditions(cache, r.dir, ["k"], racing), { calls: 2 });
  assert.equal(cache.entries.size, 0);
});

test("feature timings report how the precondition cache was used", () => {
  const base = { checks: [], reviewMs: null, totalMs: 1, rechecks: { count: 3, ms: 2 } };
  assert.deepEqual(
    featureTimings({ ...base, cache: { hits: 2, misses: 1, fresh: 2 } }).precondition_cache,
    { hits: 2, misses: 1, fresh: 2 },
  );
  assert.equal(featureTimings(base).precondition_cache, null);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createPreconditionCache,
  memoizePreconditions,
  preconditionCacheStats,
} from "../pi/agent/lib/verification/precondition-cache.mjs";
import { featureTimings } from "../pi/agent/lib/verification/timings.mjs";

// The cache key holds the feature state, which includes every recorded attempt, checkpoint and
// history entry. The ledger's artifacts are content-addressed and immutable, so no evidence
// fingerprint is needed: a change that matters changes the key.
const repository = "/unused";

function counter(value = { tasks: ["one"] }) {
  const state = { calls: 0 };
  return { state, compute: async () => { state.calls += 1; return structuredClone(value); } };
}

test("without a cache every call computes", async () => {
  const { state, compute } = counter();
  await memoizePreconditions(undefined, repository, ["k"], compute);
  await memoizePreconditions(undefined, repository, ["k"], compute);
  assert.equal(state.calls, 2);
  assert.equal(preconditionCacheStats(undefined), null);
});

test("an unchanged key reuses the earlier result", async () => {
  const cache = createPreconditionCache();
  const { state, compute } = counter();
  assert.deepEqual(await memoizePreconditions(cache, repository, ["k"], compute), { tasks: ["one"] });
  assert.deepEqual(await memoizePreconditions(cache, repository, ["k"], compute), { tasks: ["one"] });
  assert.equal(state.calls, 1);
  assert.deepEqual(preconditionCacheStats(cache), { hits: 1, misses: 1, fresh: 0 });
});

test("a changed key part, such as a new recorded attempt or history entry, forces a recompute", async () => {
  const cache = createPreconditionCache();
  const { state, compute } = counter();
  await memoizePreconditions(cache, repository, [{ attempts: 1 }], compute);
  await memoizePreconditions(cache, repository, [{ attempts: 2 }], compute);
  await memoizePreconditions(cache, repository, [{ attempts: 1 }], compute);
  assert.equal(state.calls, 2);
});

test("fresh always recomputes and refreshes the entry", async () => {
  const cache = createPreconditionCache();
  const { state, compute } = counter();
  await memoizePreconditions(cache, repository, ["k"], compute);
  await memoizePreconditions(cache, repository, ["k"], compute, { fresh: true });
  await memoizePreconditions(cache, repository, ["k"], compute);
  assert.equal(state.calls, 2);
  assert.deepEqual(preconditionCacheStats(cache), { hits: 1, misses: 1, fresh: 1 });
});

test("failures are never cached", async () => {
  const cache = createPreconditionCache();
  let calls = 0;
  const flaky = async () => {
    calls += 1;
    if (calls === 1) throw new Error("Evidence digest mismatch");
    return { ok: true };
  };
  await assert.rejects(memoizePreconditions(cache, repository, ["k"], flaky), /digest mismatch/);
  assert.deepEqual(await memoizePreconditions(cache, repository, ["k"], flaky), { ok: true });
  assert.equal(calls, 2);
  await memoizePreconditions(cache, repository, ["k"], flaky);
  assert.equal(calls, 2);
});

test("callers cannot corrupt a cached result by mutating what they were given", async () => {
  const cache = createPreconditionCache();
  const { compute } = counter({ tasks: { one: { status: "completed" } } });
  const first = await memoizePreconditions(cache, repository, ["k"], compute);
  first.tasks.one.status = "mutated";
  const hit = await memoizePreconditions(cache, repository, ["k"], compute);
  assert.equal(hit.tasks.one.status, "completed");
  hit.tasks.one.status = "mutated again";
  assert.equal((await memoizePreconditions(cache, repository, ["k"], compute)).tasks.one.status, "completed");
});

test("feature timings report how the precondition cache was used", () => {
  const base = { checks: [], reviewMs: null, totalMs: 1, rechecks: { count: 3, ms: 2 } };
  assert.deepEqual(
    featureTimings({ ...base, cache: { hits: 2, misses: 1, fresh: 2 } }).precondition_cache,
    { hits: 2, misses: 1, fresh: 2 },
  );
  assert.equal(featureTimings(base).precondition_cache, null);
});

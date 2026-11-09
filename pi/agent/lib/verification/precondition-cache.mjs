// Per-run memo for the expensive, immutable part of validate_feature preconditions.
//
// Deriving preconditions authenticates every completed task: it walks each
// checkpoint commit, re-reads and re-verifies each task's evidence and attempt
// chain, re-authenticates amendments and scans prior feature reviews. That result
// is a pure function of
//   - the Scaffold feature state (excluding `validation`, which only the gate writes),
//   - the validation arguments,
//   - Git objects, which are immutable by SHA, and
//   - the ledger's artifacts, which are content-addressed and immutable.
// A result is reused only when the feature state (which includes every recorded attempt,
// checkpoint and history entry) and the arguments are unchanged, so a persistent change
// to either forces a full recompute. Failures are never cached. Callers can also demand a
// full recompute; validate_feature does so for the first and the last derivation of
// every run, so a persistent change to any input, including check logs outside the
// evidence directory, is still caught before a receipt is retained.
import { createHash } from "node:crypto";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

export function createPreconditionCache() {
  return { entries: new Map(), hits: 0, misses: 0, fresh: 0 };
}

export const preconditionCacheStats = (cache) =>
  cache ? { hits: cache.hits, misses: cache.misses, fresh: cache.fresh } : null;

// Return compute()'s result, reusing an earlier one when every input is unchanged.
// `keyParts` must contain everything compute() reads other than evidence files.
export async function memoizePreconditions(cache, repository, keyParts, compute, { fresh = false } = {}) {
  if (!cache) return compute();
  const key = sha256(JSON.stringify(keyParts));
  const entry = cache.entries.get(key);
  if (!fresh && entry) {
    cache.hits += 1;
    return structuredClone(entry.value);
  }
  cache[fresh ? "fresh" : "misses"] += 1;
  const value = await compute();
  try {
    cache.entries.set(key, { value: structuredClone(value) });
  } catch {
    cache.entries.delete(key);
  }
  return value;
}

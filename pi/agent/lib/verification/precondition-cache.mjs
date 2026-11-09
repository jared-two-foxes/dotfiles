// Per-run memo for the expensive, immutable part of validate_feature preconditions.
//
// Deriving preconditions authenticates every completed task: it walks each
// checkpoint commit, re-reads and re-verifies each task's evidence and attempt
// chain, re-authenticates amendments and scans prior feature reviews. That result
// is a pure function of
//   - the Scaffold feature state (excluding `validation`, which only the gate writes),
//   - the validation arguments,
//   - Git objects, which are immutable by SHA, and
//   - the retained evidence files.
// A result is reused only when all of those are unchanged, so a persistent change
// to the feature state, an argument, or any evidence file (added, removed, edited)
// forces a full recompute. Failures are never cached. Callers can also demand a
// full recompute; validate_feature does so for the first and the last derivation of
// every run, so a persistent change to any input, including check logs outside the
// evidence directory, is still caught before a receipt is retained.
import { createHash } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { evidenceDirectory } from "../evidence/store.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

// Digest of every evidence file's name, size, inode and timestamps. Detects files
// added, removed, replaced or modified in place (ctime changes even if mtime is
// restored). A hash of local metadata is not proof against a determined local
// attacker, which the evidence design already does not claim to resist.
export async function evidenceFingerprint(repository) {
  let directory;
  try {
    directory = await evidenceDirectory(repository);
  } catch (error) {
    if (error.code === "ENOENT") return "absent";
    throw error;
  }
  const names = (await readdir(directory)).sort();
  // Concurrent stats: hundreds of sequential awaits cost more than the stats themselves.
  const lines = await Promise.all(names.map(async (name) => {
    try {
      const info = await lstat(path.join(directory, name));
      return [name, info.isFile(), info.size, info.ino, info.mtimeMs, info.ctimeMs].join("\0");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      return name + "\0gone"; // removed while listing: a different fingerprint, not a failure
    }
  }));
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

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
  const fingerprint = await evidenceFingerprint(repository);
  const entry = cache.entries.get(key);
  if (!fresh && entry?.fingerprint === fingerprint) {
    cache.hits += 1;
    return structuredClone(entry.value);
  }
  cache[fresh ? "fresh" : "misses"] += 1;
  const value = await compute();
  // Evidence that changed while computing means the result may mix old and new
  // state, so it is returned to this caller but never reused.
  if ((await evidenceFingerprint(repository)) === fingerprint) {
    try {
      cache.entries.set(key, { fingerprint, value: structuredClone(value) });
    } catch {
      cache.entries.delete(key);
    }
  } else cache.entries.delete(key);
  return value;
}

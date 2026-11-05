// Immutable, content-addressed task and feature receipt storage.
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, writeFile, realpath } from "node:fs/promises";
import path from "node:path";
import { git } from "../git/tree.mjs";
import { validateBinding } from "../delivery-state/binding.mjs";
export const digest = value => createHash("sha256").update(value).digest("hex");

async function directory(repository, create = false) {
  const dir = path.resolve(
    repository,
    git(repository, [
      "rev-parse",
      "--git-path",
      "pi-conductor-evidence",
    ]).trim(),
  );
  try {
    const stat = await lstat(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error("Evidence directory must be a regular directory");
  } catch (error) {
    if (error.code !== "ENOENT" || !create) throw error;
    await mkdir(dir, { mode: 0o700 });
  }
  return dir;
}

export async function retainEvidence(repository, record) {
  const bytes = JSON.stringify({
    schema: "pi.task-attempt/v1",
    recordedAt: new Date().toISOString(),
    ...record,
  });
  const hash = digest(bytes);
  const dir = await directory(repository, true);
  await writeFile(path.join(dir, hash + ".json"), bytes, {
    flag: "wx",
    mode: 0o600,
  });
  return "pi-evidence:sha256:" + hash;
}

export async function readEvidence(repository, reference) {
  const match = /^pi-evidence:sha256:([a-f0-9]{64})$/.exec(reference ?? "");
  if (!match)
    throw Object.assign(new Error("Invalid evidence reference; expected pi-evidence:sha256: followed by 64 lowercase hex characters"), {
      code: "CONTINUATION_RECEIPT_MALFORMED",
    });
  let file, stat;
  try {
    file = path.join(await directory(repository), match[1] + ".json");
    stat = await lstat(file);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    throw Object.assign(new Error("Evidence receipt is missing from this checkout"), {
      code: "CONTINUATION_RECEIPT_MISSING",
    });
  }
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error("Evidence must be a regular file");
  const bytes = await readFile(file, "utf8");
  if (digest(bytes) !== match[1]) throw new Error("Evidence digest mismatch");
  const record = JSON.parse(bytes);
  if (
    record.schema !== "pi.task-attempt/v1" ||
    (await realpath(record.repository)) !== (await realpath(repository))
  ) {
    throw new Error("Evidence schema or repository mismatch");
  }
  validateBinding(record.task);
  return record;
}

// Separate namespace: task receipt readers can never accept feature-shaped records.
export async function retainFeatureEvidence(repository, record) {
  const bytes = JSON.stringify({
    ...record,
    schema: "pi.feature-attempt/v1",
    repository,
    recordedAt: new Date().toISOString(),
  });
  const hash = digest(bytes);
  await writeFile(
    path.join(await directory(repository, true), "feature-" + hash + ".json"),
    bytes,
    { flag: "wx", mode: 0o600 },
  );
  return "pi-feature-evidence:sha256:" + hash;
}
export async function readFeatureEvidence(repository, reference) {
  const match = /^pi-feature-evidence:sha256:([a-f0-9]{64})$/.exec(
    reference ?? "",
  );
  if (!match) throw new Error("Invalid feature evidence reference");
  const file = path.join(
    await directory(repository),
    "feature-" + match[1] + ".json",
  );
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error("Feature evidence must be a regular file");
  const bytes = await readFile(file, "utf8");
  if (digest(bytes) !== match[1])
    throw new Error("Feature evidence digest mismatch");
  const record = JSON.parse(bytes);
  if (
    record.schema !== "pi.feature-attempt/v1" ||
    (await realpath(record.repository)) !== (await realpath(repository))
  )
    throw new Error("Feature evidence schema/repository mismatch");
  return record;
}
export async function featureEvidenceReferences(repository) {
  const { readdir } = await import("node:fs/promises");
  let dir;
  try {
    dir = await directory(repository);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  return (await readdir(dir))
    .filter((f) => /^feature-[a-f0-9]{64}\.json$/.test(f))
    .map((f) => "pi-feature-evidence:sha256:" + f.slice(8, -5));
}

// Read-only discovery for recovery and stale-attempt protection across rebase epochs.
export async function taskEvidenceReferences(repository) {
  const { readdir } = await import("node:fs/promises");
  let dir;
  try {
    dir = await directory(repository);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  return (await readdir(dir))
    .filter((f) => /^[a-f0-9]{64}\.json$/.test(f))
    .map((f) => "pi-evidence:sha256:" + f.slice(0, -5));
}

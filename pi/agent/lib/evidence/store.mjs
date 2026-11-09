// Receipts and feature records are artifacts in the Scaffold ledger (`artifact-put` / `artifact-get`).
// Nothing is stored in Git metadata. A reference is `sha256:<digest of the canonical record>`.
//
// An artifact belongs to one feature instance's ledger, so a store call needs a feature: writes
// route by the record's own feature id; reads search the repository's open features (normally one).
import path from "node:path";
import { realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { scaffoldCall, openFeatureIds } from "../scaffold/client.mjs";
import { validateBinding } from "../delivery-state/binding.mjs";

export const digest = (value) => createHash("sha256").update(value).digest("hex");
const REFERENCE = /^sha256:[a-f0-9]{64}$/;

function featureIdOf(record) {
  const id = record.task?.featureId ?? record.binding?.feature_id ?? record.featureId ?? record.feature?.id;
  if (typeof id !== "string" || !id) throw new Error("Evidence needs the feature it belongs to (task.featureId or binding.feature_id)");
  return id;
}

async function put(repository, record, options) {
  const response = await scaffoldCall(
    repository,
    { operation: "artifact-put", feature_id: featureIdOf(record), payload: record },
    options?.scaffoldOptions,
  );
  return response.reference;
}

// Search order: the feature named by `options.featureId`, else every open feature.
async function get(repository, reference, options) {
  if (!REFERENCE.test(reference ?? ""))
    throw Object.assign(new Error("Invalid evidence reference; expected sha256: followed by 64 lowercase hex characters"), {
      code: "CONTINUATION_RECEIPT_MALFORMED",
    });
  const ids = options?.featureId ? [options.featureId] : await openFeatureIds(repository, options?.scaffoldOptions);
  for (const id of ids) {
    try {
      const response = await scaffoldCall(
        repository,
        { operation: "artifact-get", feature_id: id, payload: { reference } },
        options?.scaffoldOptions,
      );
      return response.artifact;
    } catch (error) {
      if (!/missing|Unknown feature/.test(error.detail ?? error.message)) throw error;
    }
  }
  throw Object.assign(new Error("Evidence receipt is missing from this repository's open features"), {
    code: "CONTINUATION_RECEIPT_MISSING",
  });
}

export async function retainEvidence(repository, record, options) {
  return put(repository, { recordedAt: new Date().toISOString(), ...record, schema: "pi.task-attempt/v1" }, options);
}

export async function readEvidence(repository, reference, options) {
  const record = await get(repository, reference, options);
  if (
    record.schema !== "pi.task-attempt/v1" ||
    (await realpath(record.repository)) !== (await realpath(repository))
  ) {
    throw new Error("Evidence schema or repository mismatch");
  }
  validateBinding(record.task);
  return record;
}

// Separate schema: task receipt readers can never accept feature-shaped records.
export async function retainFeatureEvidence(repository, record, options) {
  return put(repository, { ...record, schema: "pi.feature-attempt/v1", repository, recordedAt: new Date().toISOString() }, options);
}

export async function readFeatureEvidence(repository, reference, options) {
  const record = await get(repository, reference, options);
  if (record.schema !== "pi.feature-attempt/v1" || path.resolve(await realpath(record.repository)) !== path.resolve(await realpath(repository)))
    throw new Error("Feature evidence schema/repository mismatch");
  return record;
}

// A terminal task receipt is stored as a ledger artifact AND recorded as the task's next attempt.
// Scaffold then requires a completion to cite the receipt of a recorded PASSED attempt.
import { retainEvidence, readEvidence } from "./store.mjs";
import { isDeepStrictEqual as equal } from "node:util";
import { scaffoldCall } from "../scaffold/client.mjs";

const record_ = (repository, reference, record, options) =>
  scaffoldCall(
    repository,
    {
      operation: "attempt-record",
      feature_id: record.task.featureId,
      task_id: record.task.taskId,
      payload: {
        attempt: record.attempt,
        status: record.result.status,
        receipt: reference,
        base: record.args?.baseRef ?? record.before.head,
        tree: record.after.tree,
      },
    },
    options?.scaffoldOptions,
  );

export async function retainAttempt(repository, record, options) {
  const reference = await retainEvidence(repository, record, options);
  await record_(repository, reference, record, options);
  return reference;
}

/**
 * Finish a write interrupted between storing a terminal receipt and recording its attempt.
 * The receipt is read back, must belong to this task, and is recorded idempotently (Scaffold accepts
 * an identical repeat and refuses anything out of sequence). Source operations are never replayed.
 */
export async function recoverAttempt(repository, reference, binding, options) {
  const record = await readEvidence(repository, reference, { ...options, featureId: binding.featureId });
  if (!equal(record.task, binding)) throw new Error("The retained receipt belongs to a different task");
  if (!record.result?.status || record.result.stage === "STARTED") throw new Error("The retained receipt is not terminal");
  await record_(repository, reference, record, options);
  return { reference, record };
}

/** The task's recorded terminal attempts as `{ reference, record }`, oldest first. */
export async function taskReceipts(repository, binding, options) {
  let feature;
  try {
    feature = (await scaffoldCall(repository, { operation: "list", feature_id: binding.featureId }, options?.scaffoldOptions)).feature;
  } catch (error) {
    if (error.code === "UNKNOWN_FEATURE") return [];
    throw error;
  }
  const out = [];
  for (const attempt of feature.tasks?.[binding.taskId]?.attempts ?? [])
    out.push({
      reference: attempt.receipt,
      record: await readEvidence(repository, attempt.receipt, { ...options, featureId: binding.featureId }),
    });
  return out;
}

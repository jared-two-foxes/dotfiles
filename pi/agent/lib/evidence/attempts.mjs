// A terminal task receipt is stored as a ledger artifact AND recorded as the task's next attempt.
// Scaffold then requires a completion to cite the receipt of a recorded PASSED attempt.
import { retainEvidence, readEvidence } from "./store.mjs";
import { scaffoldCall } from "../scaffold/client.mjs";

export async function retainAttempt(repository, record, options) {
  const reference = await retainEvidence(repository, record, options);
  await scaffoldCall(
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
  return reference;
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

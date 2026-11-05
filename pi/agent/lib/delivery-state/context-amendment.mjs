// Authenticate retained contract deltas without consulting the task runtime.
import { isDeepStrictEqual as equal } from "node:util";
import { readEvidence, readFeatureEvidence } from "./evidence.mjs";
const requireValue = (ok, message) => {
  if (!ok) throw new Error(message);
};

export async function authenticateAmendment(repository, reference, task) {
  const record = await readFeatureEvidence(repository, reference);
  requireValue(
    record.kind === "delivery-amendment" &&
      record.approved === true &&
      record.scope.task.featureId === task.featureId &&
      record.scope.task.designRef === task.designRef,
    "Amendment requires explicit matching feature authority",
  );
  const previous = await readEvidence(repository, record.scope.previousAttempt);
  requireValue(
    equal(previous.task, record.scope.task) &&
      equal(previous.after, record.scope.source) &&
      record.scope.ids.every((id) =>
        (previous.args.deliveryContext?.contractItems ?? [])
          .concat(previous.args.deliveryContext?.obligations ?? [])
          .some((o) => o.id === id),
      ),
    "Amendment has no authenticated originating obligations",
  );
  return { reference, ...record.scope };
}

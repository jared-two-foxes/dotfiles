// A feature can be cleaned and re-initialized with an identical ticket, design,
// branch and Git baseline. Scaffold's per-initialization identity prevents
// retaining authority or replaying receipts from that previous incarnation.
//
// Existing schema-v2 features created before Scaffold introduced instance_id
// remain readable and keep their existing authorization/receipt contracts.
const INSTANCE_ID = /^[a-f0-9]{32}$/;

export function featureInstanceId(feature) {
  const value = feature?.workflow?.instance_id;
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !INSTANCE_ID.test(value))
    throw new Error("Invalid Scaffold feature initialization identity");
  return value;
}

export function requireCurrentFeatureReceipt(feature, receipt) {
  if (!feature || typeof feature !== "object")
    throw new Error("Current Scaffold feature is required for receipt verification");
  const expected = featureInstanceId(feature);
  if (receipt?.featureInstanceId !== expected) {
    throw new Error(
      "Feature was cleaned or reinitialized: retained evidence belongs to a different feature instance. " +
      "Do not reuse the old receipt; initialize/approve a new feature and begin new task attempts.",
    );
  }
}

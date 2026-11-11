import test from "node:test";
import assert from "node:assert/strict";
import { obligationsToAssess, featureObligationsVerified } from "../pi/agent/lib/verification/feature.mjs";

const task = (obligations, amendments = []) => ({ delivery: { context: { obligations, amendments } } });

test("final review is asked to assess every obligation the pass gate requires", () => {
  const tasks = {
    a: task([{ id: "finding-1", status: "open" }, { id: "check-1", status: "independently_verified" }]),
    b: task([{ id: "finding-2", status: "open" }, { id: "finding-3", status: "open" }], [{ ids: ["finding-3"] }]),
    c: task([]),
  };
  const feature = [{ id: "finding-9", status: "open" }, { id: "finding-8", status: "independently_verified" }];
  const ids = obligationsToAssess(tasks, feature).map((o) => o.id).sort();
  assert.deepEqual(ids, ["finding-1", "finding-2", "finding-9"]);
  // A review that assesses exactly that list satisfies the task-level gate.
  const review = { obligation_assessments: ids.map((id) => ({ obligation_id: id, disposition: "verified", evidence: "inspected" })) };
  assert.equal(featureObligationsVerified(tasks, review), true);
  // Assessing only the feature-level obligation (the SA-587 failure) does not.
  const partial = { obligation_assessments: [{ obligation_id: "finding-9", disposition: "verified", evidence: "inspected" }] };
  assert.equal(featureObligationsVerified(tasks, partial), false);
});

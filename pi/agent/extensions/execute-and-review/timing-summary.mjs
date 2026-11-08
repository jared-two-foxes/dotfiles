#!/usr/bin/env node
// Print retained delivery timings for a checkout: `node timing-summary.mjs [repository]`.
// Read-only. Receipts written before timing telemetry existed are listed as unavailable.
import path from "node:path";
import { git } from "../../lib/git/tree.mjs";
import { repositoryTimings } from "../../lib/verification/timings.mjs";

const repository = path.resolve(
  git(process.argv[2] ?? process.cwd(), ["rev-parse", "--show-toplevel"]).trim(),
);
const directory = path.resolve(
  repository,
  git(repository, ["rev-parse", "--git-path", "pi-conductor-evidence"]).trim(),
);
const fmt = (ms) => (ms === null || ms === undefined ? "-" : (ms / 1000).toFixed(1) + "s");
const rows = await repositoryTimings(directory).catch((error) => {
  console.error("No evidence directory: " + error.message);
  process.exit(1);
});
if (!rows.length) console.log("No receipts found.");
for (const row of rows) {
  if (!row.available) {
    console.log(`${row.recordedAt ?? "?"}  ${row.task ?? "?"}  ${row.status ?? "?"}  (no timing telemetry)`);
  } else if (row.kind === "task") {
    console.log(
      `${row.recordedAt}  ${row.task}  ${row.status}  attempt=${row.attempt ?? "?"}  ` +
        `execute=${fmt(row.execution_ms)}  checks=${fmt(row.checks_ms)}  review=${fmt(row.review_ms)}  ` +
        `seal-prep=${fmt(row.seal_prep_ms)}  ledger-events=${row.review_ledger_events ?? "-"}`,
    );
  } else {
    console.log(
      `${row.recordedAt}  feature ${row.task}  ${row.status}  checks=${fmt(row.checks_ms)}  ` +
        `review=${fmt(row.review_ms)}  precondition-checks=${row.precondition_checks} (${fmt(row.precondition_ms)})  ` +
        `total=${fmt(row.total_ms)}`,
    );
  }
}

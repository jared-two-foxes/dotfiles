import path from "node:path";
import { git } from "../../lib/git/tree.mjs";
import { snapshot } from "../../lib/git/snapshot.mjs";
import { readEvidence } from "../../lib/evidence/store.mjs";
import { verifiedResult } from "../../lib/verification/result.mjs";
import { taskHasNoDelta } from "../../lib/verification/no-delta.mjs";
import { summarizeTimings } from "../../lib/verification/timings.mjs";
export async function inspectEvidence(reference, context) {
  try {
    const repository = path.resolve(
      git(context.directory, ["rev-parse", "--show-toplevel"]).trim(),
    );
    const record = await readEvidence(repository, reference);
    const current = await snapshot(repository);
    return {
      ok: true,
      reference,
      record,
      current,
      matchesWorkingTree:
        current.head === record.after?.head &&
        current.digest === record.after?.digest,
      structurallyVerified: verifiedResult(record.result, record.args, {
        noDelta: taskHasNoDelta(repository, record.args?.baseRef, record.after?.tree),
      }),
      timingSummary: summarizeTimings(record),
    };
  } catch (error) {
    return { ok: false, message: error.message };
  }
}

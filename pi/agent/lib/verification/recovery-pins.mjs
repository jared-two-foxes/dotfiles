// Keep the before/after trees of every attempt in a handoff chain reachable, so Git garbage
// collection cannot lose the source a correction depends on. (Remaining use of refs/pi-*;
// saved source is a Git object, not a ledger record.)
import { git } from "../git/tree.mjs";
import { recoveryCommitEnvironment } from "../git/recovery-tree.mjs";
import { authenticateAttemptChain } from "./attempt-chain.mjs";

const requireValue = (ok, message) => { if (!ok) throw new Error(message); };

export async function pinHandoff(repository, reference, handoff) {
  const { records } = await authenticateAttemptChain(repository, reference, handoff.task, new Set(), reference);
  const prefix = "refs/pi-task-recoveries/" + reference.split(":").at(-1);
  const updates = [];
  for (const [index, record] of records.entries()) {
    for (const side of ["before", "after"]) {
      const commit = git(repository, ["commit-tree", record[side].tree, "-p", record.args.baseRef], {
        input: "Pi task recovery snapshot " + index + " " + side + "\n",
        env: recoveryCommitEnvironment,
      });
      const ref = prefix + "/record-" + index + "-" + side;
      let existing;
      try { existing = git(repository, ["rev-parse", "--verify", "--quiet", ref]); } catch {}
      requireValue(!existing || existing === commit, "Recovery audit ref unexpectedly changed");
      if (!existing) updates.push("create " + ref + " " + commit);
    }
  }
  if (updates.length)
    git(repository, ["update-ref", "--stdin"], { input: "start\n" + updates.join("\n") + "\nprepare\ncommit\n" });
}

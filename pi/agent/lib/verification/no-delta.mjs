import { git } from "../git/tree.mjs";

// A parent or aggregate task can introduce nothing of its own: its work was committed by its child tasks,
// so the working tree already equals the tree of the task's base. Its review diff is empty by construction.
export function taskHasNoDelta(repository, baseRef, tree) {
  try {
    return /^[a-f0-9]{40}$/.test(tree ?? "") && git(repository, ["rev-parse", `${baseRef}^{tree}`]).trim() === tree;
  } catch {
    return false;
  }
}

export const NO_DELTA_REVIEW_NOTE =
  "\n\nThis task introduces no changes of its own: its source tree equals its base tree, because its work was " +
  "committed by earlier child tasks. An empty comparison is therefore expected and is not a finding. Assess the " +
  "task's targeted checks. Cross-task and baseline-to-HEAD obligations are re-verified at final feature " +
  "validation, so leave them unresolved here rather than raising a blocking finding.";

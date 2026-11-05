import { scaffoldTasks } from "./adapter.mjs";
import { authenticateIssueMutation } from "../delivery-state/issue-authorization.mjs";
import { checkpointVerifiedTask as checkpoint } from "../delivery-state/checkpoint.mjs";
import { git } from "../delivery-state/git-tree.mjs";
import path from "node:path";
export { checkpointAuthorization } from "../delivery-state/checkpoint.mjs";

export async function checkpointVerifiedTask(args, context = {}, options = {}) {
  let repository;
  try {
    repository = path.resolve(git(context.directory, ["rev-parse", "--show-toplevel"]));
    const scopedContext = { ...context, directory: repository };
    const state = await scaffoldTasks(
      { operation: "list", feature_id: args.task.featureId },
      scopedContext,
      options.scaffoldOptions,
    );
    if (!state.ok) throw new Error(state.message ?? "Cannot inspect checkpoint feature");
    const result = await checkpoint(args, { feature: state.data.feature }, scopedContext, options);
    if (!result.ok) return result;
    const recorded = await scaffoldTasks(
      {
        operation: "checkpoint-record",
        feature_id: args.task.featureId,
        task_id: args.task.taskId,
        payload: { commit: result.commit, reference: args.evidenceRef },
      },
      scopedContext,
      { ...options.scaffoldOptions, authorizeIssueMutation: authenticateIssueMutation },
    );
    if (!recorded.ok) throw new Error(recorded.message ?? "Cannot record verified checkpoint");
    return result;
  } catch (error) {
    return {
      ok: false,
      reason: "CHECKPOINT_BLOCKED",
      message: error.message,
      ...(repository ? { repository } : {}),
      recovery: "Inspect Scaffold, receipt, HEAD and index before retrying; never reset or replay blindly",
    };
  }
}

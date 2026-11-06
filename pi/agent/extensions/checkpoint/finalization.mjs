// Conductor's post-review Git commit command. It consumes an immutable successful
// receipt; never applies source changes or reruns implementation/review.
import { authenticateTaskEvidence } from "../../lib/verification/task-evidence.mjs";
import { requireCurrentFeatureReceipt } from "../../lib/verification/feature-instance.mjs";
import { requireFeatureAuthorization, featureAuthorized } from "../scaffold/feature-authorization.mjs";
import { checkpointVerifiedTask } from "./scaffold.mjs";
import { snapshot } from "../../lib/git/snapshot.mjs";
import { assertLatestAttempt } from "../../lib/verification/attempt-chain.mjs";
import { issueExecutionScope } from "../../lib/verification/issue-scope.mjs";
import { issueDesignRequirements } from "../../lib/scaffold/contracts.mjs";
import { scaffoldTasks } from "../scaffold/adapter.mjs";
import { git, assertNoGitOperation } from "../../lib/git/tree.mjs";
import path from "node:path";
const requireValue = (ok, message) => {
  if (!ok) throw new Error(message);
};

export async function commitVerifiedTask(args, context = {}, options = {}) {
  try {
    await requireFeatureAuthorization(args, context, options);
    const repository = path.resolve(
      git(context.directory, ["rev-parse", "--show-toplevel"]),
    );
    await assertNoGitOperation(repository);
    requireValue(
      typeof args.defaultBranch === "string" &&
        args.defaultBranch.trim() &&
        Array.isArray(args.protectedBranches) &&
        args.protectedBranches.every((x) => typeof x === "string"),
      "Known branch protection metadata required",
    );
    requireValue(
      ![
        "main",
        "master",
        args.defaultBranch,
        ...args.protectedBranches,
      ].includes(args.branch),
      "Protected branch checkpoint prohibited",
    );
    const record = await authenticateTaskEvidence(
      repository,
      args.evidenceRef,
      args.task,
    );
    await assertLatestAttempt(
      repository,
      args.evidenceRef,
      args.task,
      record.attempt,
    );
    const response = await scaffoldTasks(
      { operation: "list", feature_id: args.task.featureId },
      context,
      options.scaffoldOptions,
    );
    const feature = response.data?.feature,
      task = feature?.tasks?.[args.task.taskId];
    if (response.ok) requireCurrentFeatureReceipt(feature, record);
    requireValue(
      response.ok &&
        feature.design_ref === args.task.designRef &&
        feature.branch === args.branch &&
        feature.original_baseline === args.featureBaseRef,
      "Checkpoint feature scope changed",
    );
    requireValue(
      ["in_progress", "completed"].includes(task?.status),
      "Task must be active or already completed with matching evidence",
    );
    requireValue(
      task.designs?.length === 1 &&
        record.args.requirements.includes(issueDesignRequirements(task)),
      "Issue design changed after review; previous evidence cannot finalize this design",
    );
    if (task.status === "in_progress") {
      const current = await snapshot(repository);
      requireValue(
        current.head === record.args.baseRef &&
          current.digest === record.after.digest &&
          current.tree === record.after.tree &&
          !current.bookkeepingVisible,
        "Source changed after review; task not completed",
      );
      await issueExecutionScope(repository, feature, record.args);
      const completed = await scaffoldTasks(
        {
          operation: "complete",
          feature_id: args.task.featureId,
          task_id: args.task.taskId,
          payload: {
            feature_id: args.task.featureId,
            task_id: args.task.taskId,
            result: "PASSED",
            source: "conductor",
            reference: args.evidenceRef,
            summary:
              "Requested checks and independent review passed; automatic verified checkpoint follows",
          },
        },
        { ...context, directory: repository },
        options.scaffoldOptions,
      );
      requireValue(completed.ok, completed.message ?? "Issue completion failed");
    }
    const checkpoint = await checkpointVerifiedTask(
      { ...args, authorizationMode: "feature" },
      context,
      {
        ...options,
        authorize: () => featureAuthorized(args, context, options),
      },
    );
    requireValue(
      checkpoint.ok,
      checkpoint.message ?? "Verified Git checkpoint failed",
    );
    return { schema: "pi.task-finalization/v1", ok: true, checkpoint };
  } catch (error) {
    return {
      schema: "pi.task-finalization/v1",
      ok: false,
      message: error.message,
      recovery:
        "Retry finalization with the same successful evidence; never reapply operations.",
    };
  }
}

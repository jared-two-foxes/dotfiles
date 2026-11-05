import { scaffoldTasks } from "./adapter.mjs";
import {
  prepareIssueHandoff as prepare,
  inspectIssueHandoff as inspect,
  readIssueHandoff,
} from "../delivery-state/issue-context.mjs";
export { inspectIssueAttempt } from "../delivery-state/issue-context.mjs";

async function scoped(featureId, taskId, context, options) {
  const response = await scaffoldTasks(
    { operation: "issue", feature_id: featureId, task_id: taskId },
    context,
    options.scaffoldOptions,
  );
  if (!response.ok) throw new Error(response.message ?? "Cannot inspect issue");
  return response.data.context;
}

export async function prepareIssueHandoff(args, context = {}, options = {}) {
  try {
    const capsule = await scoped(args.featureId, args.taskId, context, options);
    const saved = await prepare(args, { capsule }, context);
    if (!saved.ok) return saved;
    const result = await inspectIssueHandoff({ reference: saved.reference }, context, options);
    if (!result.ok || !result.applicable)
      return {
        ok: false,
        reference: saved.reference,
        message: result.message ?? result.reason ?? "Context changed while saving handoff",
      };
    return result;
  } catch (error) {
    return { ok: false, message: error.message };
  }
}

export async function inspectIssueHandoff(args, context = {}, options = {}) {
  try {
    const { reference, record } = await readIssueHandoff(args, context);
    const { featureId, taskId } = record.binding;
    let capsule;
    try {
      capsule = await scoped(featureId, taskId, context, options);
    } catch (error) {
      return {
        ok: true,
        applicable: false,
        reference,
        reason: error.message,
        refresh: { tool: "prepare_issue_handoff", featureId, taskId },
      };
    }
    return inspect({ reference }, { capsule }, context);
  } catch (error) {
    return { ok: false, message: error.message };
  }
}

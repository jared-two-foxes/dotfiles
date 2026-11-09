import { scaffoldTasks } from "./adapter.mjs";
import * as authorization from "../../lib/authorization/feature.mjs";

async function readFeature(args, context, options) {
  const response = await scaffoldTasks(
    { operation: "list", feature_id: args.featureId ?? args.task?.featureId },
    context,
    options.scaffoldOptions,
  );
  if (!response.ok) throw new Error("Cannot inspect feature direction");
  return response.data.feature;
}

export async function featureAuthorized(args, context = {}, options = {}) {
  try {
    return await authorization.featureAuthorized(
      args,
      { feature: await readFeature(args, context, options) },
      context,
    );
  } catch {
    return false;
  }
}

export async function requireFeatureAuthorization(args, context = {}, options = {}) {
  return authorization.requireFeatureAuthorization(
    args,
    { feature: await readFeature(args, context, options) },
    context,
  );
}

export async function approveFeatureDirection(args, context = {}, options = {}) {
  try {
    return await authorization.approveFeatureDirection(
      args,
      { feature: await readFeature(args, context, options) },
      context,
      {
        confirmFeature: async (scope) =>
          (await options.confirm?.(scope)) ? readFeature(args, context, options) : false,
        record: async (payload) => {
          const response = await scaffoldTasks(
            { operation: "direction-approve", feature_id: args.featureId, payload },
            context,
            options.scaffoldOptions,
          );
          if (!response.ok) throw new Error("Scaffold refused the approval: " + response.message);
        },
      },
    );
  } catch (error) {
    return { ok: false, message: error.message };
  }
}

import { readScaffoldState, scaffoldTasks } from "./adapter.mjs";
import * as authorization from "../../lib/authorization/feature.mjs";
import { git } from "../../lib/git/tree.mjs";

async function readFeature(args, context, options) {
  const response = await scaffoldTasks(
    { operation: "list", feature_id: args.featureId ?? args.task?.featureId },
    context,
    options.scaffoldOptions,
  );
  if (!response.ok) throw new Error("Cannot inspect feature direction");
  return response.data.feature;
}

async function structures(args, context, options) {
  const feature = await readFeature(args, context, options);
  const repository = git(context.directory, ["rev-parse", "--show-toplevel"]);
  const state = await readScaffoldState(repository);
  return { feature, tasks: state?.features?.[feature.id]?.tasks };
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

export async function requireFeatureAuthorization(
  args,
  context = {},
  options = {},
) {
  return authorization.requireFeatureAuthorization(
    args,
    await structures(args, context, options),
    context,
  );
}

export async function approveFeatureDirection(
  args,
  context = {},
  options = {},
) {
  try {
    return await authorization.approveFeatureDirection(
      args,
      await structures(args, context, options),
      context,
      {
        confirmFeature: async (scope) =>
          (await options.confirm?.(scope))
            ? readFeature(args, context, options)
            : false,
      },
    );
  } catch (error) {
    return { ok: false, message: error.message };
  }
}

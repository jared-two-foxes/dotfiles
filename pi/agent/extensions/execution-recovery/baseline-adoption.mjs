// Native entry points: adopt a user-approved execution baseline; inspect drift read-only.
import path from 'node:path';
import { git } from '../../lib/git/tree.mjs';
import { adoptFeatureBaseline } from '../../lib/verification/baseline-adoption.mjs';
import { inspectFeatureDrift } from '../../lib/verification/drift.mjs';
import { scaffoldTasks } from '../scaffold/adapter.mjs';

const reader = (featureId, context, options) => async () => {
  const response = await scaffoldTasks({ operation: 'list', feature_id: featureId }, context, options.scaffoldOptions);
  if (!response.ok) throw new Error('Cannot inspect Scaffold: ' + (response.message ?? 'invalid state'));
  return response.data.feature;
};
export const adoptBaseline = (args, context = {}, options = {}) =>
  adoptFeatureBaseline(args, { readFeature: reader(args.featureId, context, options) }, context, options);
export async function inspectDrift(args, context = {}, options = {}) {
  try {
    const feature = await reader(args.featureId, context, options)();
    return await inspectFeatureDrift(path.resolve(git(context.directory, ['rev-parse', '--show-toplevel'])), feature, context);
  } catch (error) { return { ok: false, message: error.message }; }
}

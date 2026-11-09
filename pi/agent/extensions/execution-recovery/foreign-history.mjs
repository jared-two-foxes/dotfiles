// Native entry points: record user-approved foreign commits; inspect drift read-only.
import path from 'node:path';
import { git } from '../../lib/git/tree.mjs';
import { adoptForeignCommits } from '../../lib/verification/foreign-history.mjs';
import { inspectFeatureDrift } from '../../lib/verification/drift.mjs';
import { scaffoldFeatureOrNull, scaffoldTasks } from '../scaffold/adapter.mjs';

async function readFeature(featureId, context, options) {
  const feature = await scaffoldFeatureOrNull(path.resolve(git(context.directory, ['rev-parse', '--show-toplevel'])), featureId, options.scaffoldOptions);
  if (!feature) throw new Error('Unknown feature: ' + featureId);
  return feature;
}
async function call(operation, featureId, payload, context, options) {
  const response = await scaffoldTasks({ operation, feature_id: featureId, payload }, context, options.scaffoldOptions);
  if (!response.ok) throw new Error('Scaffold refused ' + operation + ': ' + response.message + (response.stderr ? ' ' + response.stderr : ''));
  return response.data;
}

export const adoptCommits = (args, context = {}, options = {}) =>
  adoptForeignCommits(args, {
    readFeature: () => readFeature(args.featureId, context, options),
    store: async artifact => (await call('artifact-put', args.featureId, artifact, context, options)).reference,
    record: payload => call('history-foreign', args.featureId, payload, context, options),
  }, context, options);

export async function inspectDrift(args, context = {}, options = {}) {
  try {
    const feature = await readFeature(args.featureId, context, options);
    return await inspectFeatureDrift(path.resolve(git(context.directory, ['rev-parse', '--show-toplevel'])), feature);
  } catch (error) { return { ok: false, message: error.message }; }
}

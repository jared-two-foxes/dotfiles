// Explicit user authority for a material contract delta. Never resets execution history.
import path from 'node:path';
import { isDeepStrictEqual as equal } from 'node:util';
import { git } from './git-tree.mjs';
import { snapshot, readEvidence, readFeatureEvidence, retainFeatureEvidence } from './evidence.mjs';
import { requireFeatureAuthorization } from './feature-authorization.mjs';
import { assertLatestAttempt } from './task-chain.mjs';
const requireValue = (ok, message) => { if (!ok) throw new Error(message); };

export async function authenticateAmendment(repository, reference, task) {
  const record = await readFeatureEvidence(repository, reference);
  requireValue(record.kind === 'delivery-amendment' && record.approved === true &&
    record.scope.task.featureId === task.featureId && record.scope.task.designRef === task.designRef,
  'Amendment requires explicit matching feature authority');
  const previous = await readEvidence(repository, record.scope.previousAttempt);
  requireValue(equal(previous.task, record.scope.task) && equal(previous.after, record.scope.source) &&
    record.scope.ids.every(id => (previous.args.deliveryContext?.contractItems ?? [])
      .concat(previous.args.deliveryContext?.obligations ?? []).some(o => o.id === id)),
  'Amendment has no authenticated originating obligations');
  return { reference, ...record.scope };
}

export async function approveDeliveryAmendment(args, context, options = {}) {
  try {
    const repository = path.resolve(git(context.directory, ['rev-parse', '--show-toplevel']));
    const previous = await readEvidence(repository, args.previousAttempt), task = previous.task;
    await requireFeatureAuthorization({ task }, context, options);
    await assertLatestAttempt(repository, args.previousAttempt, task, previous.attempt);
    requireValue(previous.result.status !== 'PASSED' && equal(await snapshot(repository), previous.after),
      'Amend the latest unfinished issue against its unchanged source/index');
    requireValue(Array.isArray(args.ids) && args.ids.length > 0 && new Set(args.ids).size === args.ids.length &&
      ['replacement', 'reason'].every(k => typeof args[k] === 'string' && args[k].trim()), 'Explicit delta, IDs and reason required');
    const items = (previous.args.deliveryContext?.contractItems ?? []).concat(previous.args.deliveryContext?.obligations ?? []);
    requireValue(args.ids.every(id => items.some(i => i.id === id)), 'Unknown original criterion/finding identity');
    const scope = { task, previousAttempt: args.previousAttempt, source: previous.after,
      ids: args.ids, original: items.filter(i => args.ids.includes(i.id)), replacement: args.replacement, reason: args.reason };
    requireValue(await options.confirm?.(scope), 'Material scope/obligation amendment requires user approval');
    context.abort?.throwIfAborted();
    await requireFeatureAuthorization({ task }, context, options);
    requireValue(equal(await snapshot(repository), scope.source), 'Source changed during amendment approval');
    await assertLatestAttempt(repository, args.previousAttempt, task, previous.attempt);
    const reference = await retainFeatureEvidence(repository, { kind: 'delivery-amendment', approved: true, scope });
    return { ok: true, reference, note: 'Apply this explicit amendment via contextUpdates. Original text, sequence and receipts remain retained; this is not verification.' };
  } catch (error) { return { ok: false, message: error.message }; }
}

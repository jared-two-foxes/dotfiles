// An issue may stay parked across further authenticated rebases.
import { readReconciliation } from './reconciliation.mjs';
export async function suspensionAnchor(repository, parked, feature, args) {
  const saved = parked.suspension.reconciliationRef ?? null;
  let reference = args.reconciliationRef ?? null;
  if (reference === saved) return;
  const seen = new Set();
  while (reference && !seen.has(reference)) {
    seen.add(reference);
    const anchor = await readReconciliation(repository, reference, feature, args);
    const prior = anchor.record.previousReconciliationRef ?? null;
    if (prior === saved) {
      const history = anchor.record.sourceCheckpoints;
      if (parked.before.head === anchor.record.oldHead || parked.before.head === args.featureBaseRef ||
          history.some(p => p.commit === parked.before.head)) return;
      throw new Error('Successor reconciliation does not include the suspended checkpoint history');
    }
    reference = prior;
  }
  throw new Error('Reconciliation is not an authenticated successor of the suspension');
}

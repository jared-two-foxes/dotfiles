import { authenticateAmendment } from '../authorization/amendment.mjs';
import { authenticateAttemptChain } from './attempt-chain.mjs';
import { readEvidence } from '../evidence/store.mjs';
import { verifiedResult } from './result.mjs';
import { isDeepStrictEqual as equal } from 'node:util';
const requireValue = (ok, message) => { if (!ok) throw new Error(message); };
const sha = x => /^[a-f0-9]{40}$/.test(x ?? '');

// Shared authentication for task checkpoints and cumulative feature validation.
// A receipt is written by Pi and stored as a hash-verified ledger artifact, so it is not re-derived from
// the Conductor request, the workflow or the review handoff. What is checked is what catches a mistake:
// the receipt belongs to this task and design, passed its checks and review, describes a clean tree,
// carries only amendments the user approved, and continues the recorded attempt chain.
export async function authenticateTaskEvidence(repository, reference, binding) {
  const record = await readEvidence(repository, reference, { featureId: binding.featureId });
  for (const a of record.args.deliveryContext?.amendments ?? [])
    requireValue(equal(await authenticateAmendment(repository, a.reference, binding), a), 'Invalid amendment authority');
  requireValue(['featureId', 'taskId', 'designRef'].every(k => record.task[k] === binding[k]), 'Task/design identity mismatch');
  requireValue(verifiedResult(record.result, record.args) && record.before?.head === record.args?.baseRef &&
    record.after?.head === record.before.head && sha(record.after?.tree), 'Missing successful task-bound verification or Git tree');
  await authenticateAttemptChain(repository, reference, binding);
  return record;
}

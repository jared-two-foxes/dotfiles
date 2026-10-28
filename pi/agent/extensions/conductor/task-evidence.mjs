// Authenticate immutable task receipts independently of current branch history.
import { sameVerification } from './verification.mjs';
import { authenticateAttemptChain } from './task-chain.mjs';
import { readEvidence, verifiedResult } from './evidence.mjs';
const requireValue = (ok, message) => { if (!ok) throw new Error(message); };
const sha = x => /^[a-f0-9]{40}$/.test(x ?? '');

// Shared authentication for task checkpoints and cumulative feature validation.
export async function authenticateTaskEvidence(repository, reference, binding) {
  const record = await readEvidence(repository, reference);
  requireValue(['featureId', 'taskId', 'designRef'].every(k => record.task[k] === binding[k]), 'Task/design identity mismatch');
  // Authenticate the retained request against the caller's full plan. The final
  // command is transparently wrapped to capture the source/index review boundary.
  const requestChecks = record.request?.checks;
  requireValue(Array.isArray(requestChecks) && requestChecks.length > 0, 'Missing requested verification plan');
  const requestedPlan = requestChecks.map((check, index) => ({
    name: check.name,
    command: index === requestChecks.length - 1
      ? JSON.parse(check.args[1]).command : [check.program, ...check.args],
  }));
  requireValue(sameVerification(record.args, { checks: requestedPlan }), 'Retained request verification plan mismatch');
  requireValue(verifiedResult(record.result, record.args) && record.before?.head === record.args?.baseRef &&
    record.after?.head === record.before.head && sha(record.after?.tree) && record.request?.review?.base_ref === record.before.head &&
    record.request?.review?.requirements === record.args.requirements &&
    record.reviewSnapshot?.head === record.after.head && record.reviewSnapshot?.tree === record.after.tree &&
    record.reviewSnapshot?.digest === record.after.digest && !record.reviewSnapshot?.bookkeepingVisible &&
    record.response?.code === 0 &&
    verifiedResult({ status: 'PASSED', conductor: JSON.parse(record.response.stdout) }, record.args), 'Missing successful task-bound verification or Git tree (legacy receipts require new verification)');
  await authenticateAttemptChain(repository, reference, binding);
  return record;
}


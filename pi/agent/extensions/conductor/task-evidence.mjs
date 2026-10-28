// Authenticate immutable task receipts independently of current branch history.
import { sameVerification } from './verification.mjs';
import { git } from './git-tree.mjs';
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
  // Prove the correction chain began clean and never changed task or baseline.
  let first = record;
  const seen = new Set();
  while (first.args.previousAttempt) {
    requireValue(!seen.has(first.args.previousAttempt), 'Cyclic receipt chain'); seen.add(first.args.previousAttempt);
    const prior = await readEvidence(repository, first.args.previousAttempt);
    requireValue(prior.attempt + 1 === first.attempt && prior.attempt < 5 &&
      ['featureId', 'taskId', 'designRef'].every(k => prior.task[k] === record.task[k]) &&
      prior.args.baseRef === record.args.baseRef && prior.args.requirements === record.args.requirements &&
      sameVerification(prior.args, record.args) &&
      prior.result.status !== 'PASSED' && prior.before.head === record.args.baseRef && prior.after.head === record.args.baseRef &&
      prior.after.digest === first.before.digest, 'Invalid correction receipt chain');
    first = prior;
  }
  requireValue(first.attempt === 1 && first.before.clean && first.before.tree === git(repository, ['rev-parse', record.args.baseRef + '^{tree}']), 'Task did not start from a clean isolated baseline');
  return record;
}


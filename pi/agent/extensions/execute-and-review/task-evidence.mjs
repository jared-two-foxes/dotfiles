import { reusableCheck } from './stage-reuse.mjs';
import { authenticateAmendment } from './context-amendment.mjs';
// Authenticate immutable task receipts independently of current branch history.
import { sameVerification } from './verification.mjs';
import { authenticateAttemptChain } from './task-chain.mjs';
import { readEvidence, verifiedResult } from './evidence.mjs';
import { reviewEvidence, reviewHandoff } from './review-evidence.mjs';
import { authenticateWorkflow } from './protocol.mjs';
import { isDeepStrictEqual as equal } from 'node:util';
import path from 'node:path';
const requireValue = (ok, message) => { if (!ok) throw new Error(message); };
const sha = x => /^[a-f0-9]{40}$/.test(x ?? '');

// Shared authentication for task checkpoints and cumulative feature validation.
export async function authenticateTaskEvidence(repository, reference, binding) {
  const record = await readEvidence(repository, reference);
  for (const a of record.args.deliveryContext?.amendments ?? [])
    requireValue(equal(await authenticateAmendment(repository, a.reference, binding), a), 'Invalid amendment authority');
  requireValue(['featureId', 'taskId', 'designRef'].every(k => record.task[k] === binding[k]), 'Task/design identity mismatch');
  // Authenticate the retained request against the caller's full plan. The final
  // command is transparently wrapped to capture the source/index review boundary.
  const modern = record.request?.schema === 'conductor.request/v2';
  if (record.result.conductor?.runner?.schema === 'pi.command-results/v1') {
    const delivery = record.deliveryRequest, prefix = record.request;
    requireValue(['pi.command-receipts/v1', 'pi.command-receipts/v2'].includes(record.producer) && delivery?.schema === 'conductor.request/v2' &&
      delivery.working_directory === repository && delivery.output_directory === prefix.output_directory &&
      delivery.commands.length === prefix.commands.length + 1 &&
      delivery.commands.slice(0, -1).every((c, i) => c.name === prefix.commands[i].name &&
        path.basename(c.args[0]) === 'command-stage.mjs' && c.args[1] === path.join(prefix.output_directory, `${i}.stage.json`) &&
        (prefix.commands[i].success_condition ? c.success_condition?.program === c.program &&
          path.basename(c.success_condition.args[0]) === 'condition-stage.mjs' &&
          c.success_condition.args[1] === c.args[1] : !c.success_condition)) &&
      path.basename(delivery.commands.at(-1).args[0]) === 'commit-task.mjs' &&
      delivery.commands.at(-1).args[1] === path.join(prefix.output_directory, 'delivery.json'), 'Missing authenticated single-list delivery context');
  }
  const requestChecks = modern
    ? authenticateWorkflow(record.workflow, record.request, record.args, repository)
    : record.request?.checks;
  requireValue(Array.isArray(requestChecks) && requestChecks.length > 0, 'Missing requested verification plan');
  const requestedPlan = requestChecks.map((check, index) => ({
    name: check.name,
    command: index === requestChecks.length - 1
      ? JSON.parse(check.args[1]).command : [check.program, ...check.args],
    ...(check.success_condition ? { successCondition: [check.success_condition.program, ...check.success_condition.args] } : {}),
  }));
  requireValue(sameVerification(record.args, { checks: requestedPlan }), 'Retained request verification plan mismatch');
  requireValue(verifiedResult(record.result, record.args) && record.before?.head === record.args?.baseRef &&
    record.after?.head === record.before.head && sha(record.after?.tree) &&
    (modern ? record.workflow.inputs.review.base_ref === record.before.head &&
      record.result.conductor?.expectedOperations === record.workflow.inputs.execution.operations.length &&
      equal(record.request, record.result.conductor?.request) &&
      equal(JSON.parse(record.response.stdout), record.result.conductor?.runner)
      : record.request?.review?.base_ref === record.before.head && record.request?.review?.requirements === record.args.requirements) &&
    record.reviewSnapshot?.head === record.after.head && record.reviewSnapshot?.tree === record.after.tree &&
    record.reviewSnapshot?.digest === record.after.digest && !record.reviewSnapshot?.bookkeepingVisible &&
    record.response?.code === 0 &&
    (modern || verifiedResult({ status: 'PASSED', conductor: JSON.parse(record.response.stdout) }, record.args)), 'Missing successful task-bound verification or Git tree (legacy receipts require new verification)');
  const runner = record.result.conductor?.runner;
  if (record.producer === 'pi.command-receipts/v2' || runner?.receipts?.at(-1)?.handoff) {
    const expected = reviewHandoff(record.workflow, reviewEvidence(record, runner, record.reviewSnapshot));
    requireValue(equal(runner.receipts.at(-1).handoff, expected.identity), 'Retained review evidence mismatch');
  }
  for (const receipt of runner?.receipts ?? []) {
    if (receipt?.reusedFrom) await reusableCheck(repository, receipt.reusedFrom.reference,
      receipt.reusedFrom.index, record.args, record.before);
  }
  await authenticateAttemptChain(repository, reference, binding);
  return record;
}


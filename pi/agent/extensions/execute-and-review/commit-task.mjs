// Last command in the same Conductor request as Executor, checks and Review.
// Seal their actual command receipts before completing/checkpointing the task.
import { readFile } from 'node:fs/promises';
import { sealVerification } from './pipeline.mjs';
import { commitVerifiedTask } from '../../lib/scaffold/task-finalization.mjs';
let result;
try {
  const input = JSON.parse(await readFile(process.argv[2], 'utf8'));
  let args = input;
  if (input.schema === 'pi.delivery-plan/v1') {
    const sealed = await sealVerification(input);
    args = { ...input.args.checkpoint, task: input.args.task, evidenceRef: sealed.reference,
      branch: input.feature.branch, featureBaseRef: input.feature.original_baseline,
      reconciliationRef: input.args.reconciliationRef };
  }
  result = await commitVerifiedTask(args, { directory: process.cwd() });
} catch (error) { result = { schema: 'pi.task-finalization/v1', ok: false, message: error.message }; }
console.log(JSON.stringify(result));
process.exitCode = result.ok ? 0 : 1;

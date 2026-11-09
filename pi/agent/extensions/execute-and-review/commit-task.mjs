// Last command in the same Conductor request as Executor, checks and Review.
// Seal their actual command receipts before completing/checkpointing the task.
import { readFile } from 'node:fs/promises';
import { sealVerification } from './pipeline.mjs';
import { commitVerifiedTask } from '../checkpoint/finalization.mjs';
import { scaffoldCliUsage } from '../scaffold/adapter.mjs';
let result;
try {
  const input = JSON.parse(await readFile(process.argv[2], 'utf8'));
  if (input.schema !== 'pi.delivery-plan/v1') throw new Error('Current delivery plan required');
  const sealed = await sealVerification(input);
  const args = { ...input.args.checkpoint, task: input.args.task, evidenceRef: sealed.reference,
    branch: input.feature.branch, featureBaseRef: input.feature.original_baseline };
  result = await commitVerifiedTask(args, { directory: process.cwd() });
} catch (error) { result = { schema: 'pi.task-finalization/v1', ok: false, message: error.message }; }
// Scaffold calls made here (authorization, completion, checkpoint) happen in this
// child process, so report them back for the parent's telemetry. Telemetry only.
result = { ...result, telemetry: { scaffold_cli: scaffoldCliUsage() } };
console.log(JSON.stringify(result));
process.exitCode = result.ok ? 0 : 1;

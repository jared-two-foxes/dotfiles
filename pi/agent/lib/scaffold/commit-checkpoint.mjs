// Commit an already verified attempt through the Scaffold orchestration boundary.
import { readFile } from 'node:fs/promises';
import { commitVerifiedTask } from './task-finalization.mjs';

let result;
try {
  const args = JSON.parse(await readFile(process.argv[2], 'utf8'));
  result = await commitVerifiedTask(args, { directory: process.cwd() });
} catch (error) {
  result = { schema: 'pi.task-finalization/v1', ok: false, message: error.message };
}
console.log(JSON.stringify(result));
process.exitCode = result.ok ? 0 : 1;

import { readFile, lstat } from 'node:fs/promises';
import { validateReviewResult } from '../review/client.mjs';

try {
  const code = Number(process.env.CONDUCTOR_COMMAND_EXIT_CODE);
  const file = process.env.CONDUCTOR_COMMAND_STDOUT_PATH;
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024)
    throw new Error('Review output is missing, unsafe or too large');
  const output = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(file));
  const review = validateReviewResult(JSON.parse(output), code);
  if (review.status !== 'APPROVED') throw new Error('Review verdict: ' + review.status);
  process.exitCode = 0;
} catch (error) {
  console.error('Review cannot authorize the next command: ' + error.message);
  process.exitCode = 1;
}

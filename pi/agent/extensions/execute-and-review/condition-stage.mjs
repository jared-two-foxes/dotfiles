// Conductor invokes this evaluator before advancing. Retain its decision so
// the final in-list commit can authenticate the prefix before Conductor returns.
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

let exit = 125;
try {
  const stage = JSON.parse(await readFile(process.argv[2], 'utf8'));
  const bytes = await readFile(stage.receipt);
  const original = JSON.parse(bytes);
  if (original.schema !== 'pi.command-receipt/v1' || original.index !== stage.index ||
      original.name !== stage.command.name || original.program !== stage.command.program ||
      JSON.stringify(original.args) !== JSON.stringify(stage.command.args) || original.status === 'BLOCKED')
    throw new Error('Original stage receipt is missing or invalid');
  const predicate = stage.command.success_condition;
  if (!predicate) throw new Error('Missing stage condition');
  const outcome = await new Promise(resolve => {
    let error;
    const child = spawn(predicate.program, predicate.args, { cwd: stage.repository, shell: false,
      windowsHide: true, stdio: ['ignore', 'inherit', 'inherit'], env: process.env });
    child.on('error', e => { error = e.message; });
    child.on('close', (code, signal) => resolve({ exit_code: code, signal, error }));
  });
  const status = outcome.error || outcome.signal || outcome.exit_code === null ? 'BLOCKED'
    : outcome.exit_code === 0 ? 'PASSED' : 'FAILED';
  await writeFile(stage.conditionReceipt, JSON.stringify({ schema: 'pi.condition-receipt/v1', index: stage.index,
    program: predicate.program, args: predicate.args,
    commandReceiptSha256: createHash('sha256').update(bytes).digest('hex'), ...outcome, status }),
  { flag: 'wx', mode: 0o600 });
  exit = status === 'BLOCKED' ? 125 : outcome.exit_code;
} catch (error) { console.error('Cannot retain condition receipt: ' + error.message); }
process.exitCode = exit;

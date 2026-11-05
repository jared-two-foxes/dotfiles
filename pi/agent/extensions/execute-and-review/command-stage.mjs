import { snapshot } from '../delivery-state/evidence.mjs';
import { prepareReviewHandoff } from './review-handoff.mjs';
import { replayCheck } from '../delivery-state/stage-reuse.mjs';
// Transparent Conductor command: preserve the child's streams and exit code,
// retaining an actual process receipt before the final in-list commit can run.
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
let exit = 125;
try {
  const stage = JSON.parse(await readFile(process.argv[2], 'utf8'));
  const sourceBefore = stage.captureSource ? await snapshot(stage.repository) : undefined;
  const handoff = stage.reviewPlan ? await prepareReviewHandoff(stage) : undefined;
  const result = stage.reuse ? await replayCheck(stage) : await new Promise(resolve => {
    let error;
    const child = spawn(stage.command.program, handoff?.args ?? stage.command.args, {
      cwd: stage.repository, shell: false, windowsHide: true, stdio: ['ignore', 'inherit', 'inherit'],
    });
    child.on('error', e => { error = e.message; });
    child.on('close', (code, signal) => resolve({ exit_code: code, signal, error }));
  });
  const status = result.error || result.signal || result.exit_code === null ? 'BLOCKED' : result.exit_code === 0 ? 'PASSED' : 'FAILED';
  if (status === 'BLOCKED') process.stderr.write('Cannot complete ' + stage.command.name + ': ' + (result.error ?? result.signal ?? 'missing process exit code') + '\n');
  await writeFile(stage.receipt, JSON.stringify({ schema: 'pi.command-receipt/v1', index: stage.index,
    ...stage.command, ...result, status,
    ...(stage.captureSource ? { sourceBefore, sourceAfter: await snapshot(stage.repository) } : {}),
    ...(handoff ? { handoff: handoff.identity } : {}) }), { flag: 'wx', mode: 0o600 });
  exit = status === 'BLOCKED' ? 125 : result.exit_code;
} catch (error) { process.stderr.write('Cannot retain command receipt: ' + error.message + '\n'); }
process.exitCode = exit;

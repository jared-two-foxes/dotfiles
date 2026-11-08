import { snapshot } from '../../lib/git/snapshot.mjs';
import { prepareReviewHandoff } from './review-handoff.mjs';
import { replayCheck } from './replay-check.mjs';
import { TIMINGS_SCHEMA, stopwatch, timingPath } from '../../lib/verification/timings.mjs';
// Transparent Conductor command: preserve the child's streams and exit code,
// retaining an actual process receipt before the final in-list commit can run.
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
let exit = 125;
try {
  const stage = JSON.parse(await readFile(process.argv[2], 'utf8'));
  const total = stopwatch();
  const timing = {};
  let mark = total.elapsed();
  const lap = key => { const now = total.elapsed(); timing[key] = Math.round((now - mark) * 1000) / 1000; mark = now; };
  const sourceBefore = stage.captureSource ? await snapshot(stage.repository) : undefined;
  lap('snapshot_ms');
  const handoff = stage.reviewPlan ? await prepareReviewHandoff(stage) : undefined;
  lap('handoff_ms');
  const result = stage.reuse ? await replayCheck(stage) : await new Promise(resolve => {
    let error;
    const child = spawn(stage.command.program, handoff?.args ?? stage.command.args, {
      cwd: stage.repository, shell: false, windowsHide: true, stdio: ['ignore', 'inherit', 'inherit'],
    });
    child.on('error', e => { error = e.message; });
    child.on('close', (code, signal) => resolve({ exit_code: code, signal, error }));
  });
  lap('process_ms');
  const status = result.error || result.signal || result.exit_code === null ? 'BLOCKED' : result.exit_code === 0 ? 'PASSED' : 'FAILED';
  if (status === 'BLOCKED') process.stderr.write('Cannot complete ' + stage.command.name + ': ' + (result.error ?? result.signal ?? 'missing process exit code') + '\n');
  const sourceAfter = stage.captureSource ? await snapshot(stage.repository) : undefined;
  lap('snapshot_after_ms');
  await writeFile(stage.receipt, JSON.stringify({ schema: 'pi.command-receipt/v1', index: stage.index,
    ...stage.command, ...result, status,
    ...(stage.captureSource ? { sourceBefore, sourceAfter } : {}),
    ...(handoff ? { handoff: handoff.identity } : {}) }), { flag: 'wx', mode: 0o600 });
  // Telemetry only: a separate sidecar so the authenticated receipt (and the
  // digest handed to independent Review) is byte-for-byte unchanged. Never fatal.
  try {
    await writeFile(timingPath(stage.receipt), JSON.stringify({ schema: TIMINGS_SCHEMA, index: stage.index,
      started_at: total.startedAt, duration_ms: total.elapsed(), ...timing, reused: Boolean(stage.reuse) }),
    { flag: 'wx', mode: 0o600 });
  } catch {}
  exit = status === 'BLOCKED' ? 125 : result.exit_code;
} catch (error) { process.stderr.write('Cannot retain command receipt: ' + error.message + '\n'); }
process.exitCode = exit;

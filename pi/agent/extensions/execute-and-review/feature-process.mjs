// Bounded verification subprocesses. No shell interpolation, retries or source operations.
import { spawn } from 'node:child_process';

export async function runCheck(command, { cwd, signal, timeoutMs = 300000 } = {}) {
  return new Promise(resolve => {
    let child, timer, bytes = 0, stdout = '', stderr = '', problem, killTimer;
    const stop = reason => {
      problem ??= reason;
      if (!child?.pid) return;
      if (process.platform === 'win32') {
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
        killer.on('error', () => child.kill('SIGKILL'));
      } else {
        try { process.kill(-child.pid, 'SIGTERM'); } catch {}
        killTimer ??= setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 250);
      }
    };
    if (signal?.aborted) return resolve({ exit_code: null, stdout, stderr, problem: 'CANCELLED' });
    try { child = spawn(command[0], command.slice(1), { cwd, shell: false, windowsHide: true,
      detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (error) { return resolve({ exit_code: null, stdout, stderr, problem: error.message }); }
    const abort = () => stop('CANCELLED');
    signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => stop('TIMEOUT'), timeoutMs);
    const collect = name => chunk => {
      bytes += chunk.length;
      if (bytes > 65536) { stop('OUTPUT_LIMIT'); return; }
      if (name === 'stdout') stdout += chunk.toString('utf8'); else stderr += chunk.toString('utf8');
    };
    child.stdout.on('data', collect('stdout')); child.stderr.on('data', collect('stderr'));
    child.on('error', error => { problem = error.code ?? error.message; });
    child.on('close', (code, killedBy) => {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      clearTimeout(killTimer);
      // Also terminate descendants that closed their pipes before their parent exited.
      if (problem && process.platform !== 'win32' && child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch {}
      }
      resolve({ exit_code: code, stdout, stderr, ...(problem || killedBy ? { problem: problem ?? killedBy } : {}) });
    });
  });
}

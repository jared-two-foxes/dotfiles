// Pi-local standalone review adapter.
// Review is repository-read-only: no executor, builds, tests, checkout or repairs.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm, lstat, readlink } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { reviewRequest, reviewStep, validateReviewResult } from './client.mjs';
export { validateReviewResult } from './client.mjs';

const OUTPUT_LIMIT = 4 * 1024 * 1024;
const DEFAULT_MODEL = 'opencode/gpt-6.1-sol';
const extraLimits = [
  ['maxToolCalls', '--max-tool-calls', 10000],
  ['maxRepeatedActions', '--max-repeated-actions', 100],
  ['maxCompletionAttempts', '--max-completion-attempts', 100],
];
function failure(reason, message) {
  return { schema: 'pi.review.error/v1', status: 'ERROR', reason, message };
}
function text(value, label, maximum = 200000) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || value.length > maximum) {
    throw new Error(`${label} must be nonempty text of at most ${maximum} characters`);
  }
  return value;
}
function integer(value, label, maximum) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${label} must be an integer between 1 and ${maximum}`);
  }
  return value;
}
function run(program, args, { cwd, signal, timeout = 15000, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { cwd, signal, env, shell: false,
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', bytes = 0, problem, settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(result);
    };
    const timer = setTimeout(() => {
      problem = Object.assign(new Error('Review subprocess exceeded its deadline'), { reason: 'TIMEOUT' });
      child.kill();
    }, timeout);
    const collect = stream => chunk => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > OUTPUT_LIMIT) {
        problem = Object.assign(new Error('Review subprocess output exceeded 4 MiB'), { reason: 'OUTPUT_LIMIT' });
        child.kill();
        return;
      }
      if (stream === 'out') stdout += chunk; else stderr += chunk;
    };
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', collect('out')); child.stderr.on('data', collect('err'));
    child.once('error', error => {
      if (error.code === 'ENOENT') error.reason = 'EXECUTABLE_NOT_FOUND';
      finish(error);
    });
    child.once('close', code => finish(problem, { code, stdout, stderr }));
  });
}
async function git(repository, args, signal) {
  const result = await run('git', ['-C', repository, ...args], { signal });
  if (result.code !== 0) throw new Error(`Git inspection failed: ${args[0]}`);
  return result.stdout;
}
async function commit(repository, ref, signal) {
  text(ref, 'Commit ref', 1024);
  return (await git(repository, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`], signal)).trim();
}
// Always monitor the live repository, even when the reviewed head is committed.
// Only the digest is returned; file contents and credentials are never returned.
async function snapshot(repository, base, signal) {
  const hash = createHash('sha256');
  hash.update(await git(repository, ['rev-parse', 'HEAD'], signal));
  hash.update(await git(repository, ['diff', '--binary', '--no-ext-diff', '--no-textconv', base, '--'], signal));
  hash.update(await git(repository, ['diff', '--cached', '--binary', '--no-ext-diff', '--no-textconv', '--'], signal));
  const files = (await git(repository, ['ls-files', '--others', '--exclude-standard', '-z'], signal))
    .split('\0').filter(Boolean).sort();
  for (const file of files) {
    const full = path.join(repository, file);
    const info = await lstat(full);
    hash.update(file + '\0');
    hash.update(info.isSymbolicLink() ? await readlink(full) : await readFile(full));
  }
  return hash.digest('hex');
}
async function reviewEnvironment() {
  const env = { ...process.env };
  if (!env.OPENCODE_API_KEY) {
    try {
      const key = (await readFile(path.join(homedir(), '.secrets', 'opencode-key'), 'utf8')).trim();
      if (key) env.OPENCODE_API_KEY = key;
    } catch { /* Provider authentication may be supplied by another route. */ }
  }
  return env;
}

export function reviewSettings(args = {}) {
  const budget = integer(args.wallClockBudgetSecs ?? 180, 'wallClockBudgetSecs', 600);
  const turns = integer(args.maxTurns ?? 20, 'maxTurns', 100);
  const limits = [];
  for (const [name, flag, maximum] of extraLimits) {
    if (args[name] != null) limits.push(flag, String(integer(args[name], name, maximum)));
  }
  if (args.maxCostUsd != null) {
    if (typeof args.maxCostUsd !== 'number' || !Number.isFinite(args.maxCostUsd) || args.maxCostUsd < 0) {
      throw new Error('maxCostUsd must be a finite nonnegative number');
    }
    limits.push('--max-cost-usd', String(args.maxCostUsd));
  }
  const model = text(args.model ?? process.env.REVIEW_MODEL ?? DEFAULT_MODEL, 'Review model', 512);
  return { budget, turns, limits, model };
}

export async function reviewChanges(args, context = {}, options = {}) {
  let temp, outcome;
  try {
    text(args?.requirements, 'Review scope');
    const settings = reviewSettings(args);
    const { budget, model } = settings;
    const directory = path.resolve(args.repository ?? context.worktree ?? context.directory ?? '.');
    const repository = (await git(directory, ['rev-parse', '--show-toplevel'], context.abort)).trim();
    const base = await commit(repository, args.baseRef, context.abort);
    const head = args.headRef === undefined || args.headRef === ':working'
      ? ':working' : await commit(repository, args.headRef, context.abort);
    const before = await snapshot(repository, base, context.abort);
    temp = await mkdtemp(path.join(tmpdir(), 'pi-review-'));
    const requirementsPath = path.join(temp, 'requirements.md');
    const requestPath = path.join(temp, 'request.json');
    const request = reviewRequest(repository, base, head, requirementsPath);
    const step = reviewStep(requestPath, request, args.requirements, settings,
      { program: options.executable ?? undefined, prefixArgs: options.prefixArgs ?? [] });
    for (const [file, contents] of step.files) await writeFile(file, contents, { mode: 0o600 });
    const output = await run(step.program, step.args, { cwd: repository, signal: context.abort,
      timeout: options.timeoutMs ?? (budget + 10) * 1000, env: await reviewEnvironment() });
    const result = validateReviewResult(JSON.parse(output.stdout), output.code);
    if (await snapshot(repository, base, context.abort) !== before) {
      throw Object.assign(new Error('Repository changed during review; result is not authoritative'),
        { reason: 'REPOSITORY_CHANGED' });
    }
    outcome = { ...result, repository, baseRef: base, headRef: head, snapshot: before, model,
      blockingFindings: result.findings.filter(f => f.blocking),
      suggestions: result.findings.filter(f => !f.blocking) };
  } catch (error) {
    outcome = failure(context.abort?.aborted ? 'CANCELLED' : error.reason ?? 'REVIEW_FAILED', error.message);
  } finally {
    if (temp) {
      try { await rm(temp, { recursive: true, force: true }); }
      catch { outcome = failure('CLEANUP_FAILED', 'Could not remove temporary review request files'); }
    }
  }
  return outcome;
}

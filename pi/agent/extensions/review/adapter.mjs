// Pi-local standalone review adapter. Do not import from an OpenCode installation.
// Review is repository-read-only: no executor, builds, tests, checkout or repairs.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm, lstat, readlink } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';

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
export function validateReviewResult(result, code) {
  const exits = { APPROVED: 0, CHANGES_REQUESTED: 1, INDETERMINATE: 3 };
  if (result?.schema !== 'review.result/v1' || !Object.hasOwn(exits, result.status) ||
      exits[result.status] !== code || !Array.isArray(result.findings) ||
      typeof result.reason !== 'string' || !result.reason.trim() ||
      typeof result.review_id !== 'string' || !result.review_id.trim() ||
      typeof result.completed_at !== 'string' || !result.completed_at.trim()) {
    throw new Error('Review result schema/status/exit code mismatch');
  }
  if (result.status !== 'INDETERMINATE' && result.reason !== 'REVIEW_COMPLETED') {
    throw new Error('An incomplete review cannot approve or reject a change');
  }
  for (const f of result.findings) {
    if (!f || typeof f !== 'object' || Array.isArray(f) || typeof f.blocking !== 'boolean' ||
        typeof f.message !== 'string' || !f.message.trim() ||
        !['high', 'medium', 'low'].includes(f.severity) ||
        (f.path != null && typeof f.path !== 'string') ||
        (f.line != null && (!Number.isInteger(f.line) || f.line < 0)) ||
        (f.recommendation != null && typeof f.recommendation !== 'string')) {
      throw new Error('Invalid review finding');
    }
  }
  const blocking = result.findings.some(f => f.blocking);
  if ((result.status === 'APPROVED' && blocking) || (result.status === 'CHANGES_REQUESTED' && !blocking)) {
    throw new Error('Review verdict contradicts blocking findings');
  }
  return result;
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
    const { budget, turns, limits, model } = reviewSettings(args);
    const directory = path.resolve(args.repository ?? context.worktree ?? context.directory ?? '.');
    const repository = (await git(directory, ['rev-parse', '--show-toplevel'], context.abort)).trim();
    const base = await commit(repository, args.baseRef, context.abort);
    const head = args.headRef === undefined || args.headRef === ':working'
      ? ':working' : await commit(repository, args.headRef, context.abort);
    const before = await snapshot(repository, base, context.abort);
    temp = await mkdtemp(path.join(tmpdir(), 'pi-review-'));
    const requirementsPath = path.join(temp, 'requirements.md');
    const requestPath = path.join(temp, 'request.json');
    await writeFile(requirementsPath, args.requirements, { mode: 0o600 });
    await writeFile(requestPath, JSON.stringify({ schema: 'review.request/v1', repository_path: repository,
      base_ref: base, head_ref: head, requirements: requirementsPath }), { mode: 0o600 });
    const executable = options.executable ?? process.env.REVIEW_CLI_BIN ?? 'review-cli';
    const argv = [...(options.prefixArgs ?? []), 'run', '--request', requestPath, '--format', 'json',
      '--model', model, '--max-turns', String(turns), '--wall-clock-budget-secs', String(budget), ...limits];
    const output = await run(executable, argv, { cwd: repository, signal: context.abort,
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

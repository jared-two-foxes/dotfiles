import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm, lstat, readlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const LIMIT = 4 * 1024 * 1024;
function run(executable, args, { cwd, signal, timeout = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, signal, shell: false, windowsHide: true });
    let stdout = '', stderr = '', bytes = 0, failure;
    const timer = setTimeout(() => {
      failure = new Error('Process exceeded its wall-clock deadline'); child.kill();
    }, timeout);
    const collect = (stream) => (chunk) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > LIMIT) { failure = new Error('Process output exceeded 4 MiB'); child.kill(); return; }
      if (stream === 'out') stdout += chunk.toString(); else stderr += chunk.toString();
    };
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', collect('out')); child.stderr.on('data', collect('err'));
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (failure) reject(failure); else resolve({ code, stdout, stderr });
    });
  });
}
async function git(repository, args) {
  const result = await run('git', ['-C', repository, ...args]);
  if (result.code !== 0) throw new Error(`Git command failed: ${args[0]}`);
  return result.stdout;
}
async function commit(repository, ref) {
  if (typeof ref !== 'string' || !ref.trim()) throw new Error('A base/head commit ref is required');
  return (await git(repository, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`])).trim();
}
// Include tracked contents, staging state, HEAD, and untracked (non-ignored) files.
// No source contents or secrets are returned, only their digest.
async function snapshot(repository, base, head) {
  const hash = createHash('sha256');
  hash.update(await git(repository, ['rev-parse', 'HEAD']));
  if (head !== ':working') return hash.update(`${base}:${head}`).digest('hex');
  hash.update(await git(repository, ['diff', '--binary', '--no-ext-diff', '--no-textconv', base, '--']));
  hash.update(await git(repository, ['diff', '--cached', '--binary', '--no-ext-diff', '--no-textconv', '--']));
  const files = (await git(repository, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean).sort();
  for (const file of files) {
    const full = path.join(repository, file);
    const info = await lstat(full);
    hash.update(file + '\0');
    hash.update(info.isSymbolicLink() ? await readlink(full) : await readFile(full));
  }
  return hash.digest('hex');
}
function validate(result, exitCode) {
  const expected = { APPROVED: 0, CHANGES_REQUESTED: 1, INDETERMINATE: 3 };
  if (result?.schema !== 'review.result/v1' || expected[result.status] !== exitCode || !Array.isArray(result.findings) || typeof result.reason !== 'string' || typeof result.review_id !== 'string') {
    throw new Error('Review result schema/status/exit code mismatch');
  }
  for (const finding of result.findings) {
    if (typeof finding.blocking !== 'boolean' || typeof finding.message !== 'string' ||
        !['high', 'medium', 'low'].includes(finding.severity) ||
        (finding.path != null && typeof finding.path !== 'string') ||
        (finding.line != null && (!Number.isInteger(finding.line) || finding.line < 0)) ||
        (finding.recommendation != null && typeof finding.recommendation !== 'string')) {
      throw new Error('Invalid review finding');
    }
  }
  const blocking = result.findings.some((f) => f.blocking);
  if ((result.status === 'APPROVED' && blocking) || (result.status === 'CHANGES_REQUESTED' && !blocking)) {
    throw new Error('Review verdict contradicts blocking findings');
  }
  return result;
}

export async function reviewChanges(args, context = {}, options = {}) {
  let temp;
  try {
    if (typeof args.requirements !== 'string' || !args.requirements.trim()) throw new Error('Acceptance criteria and review scope are required');
    if (args.requirements.length > 200000) throw new Error('Requirements exceed 200,000 characters');
    const budget = args.wallClockBudgetSecs ?? 180;
    const maxTurns = args.maxTurns ?? 20;
    if (!Number.isInteger(budget) || budget < 1 || budget > 600 || !Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > 100) {
      throw new Error('Invalid review budget');
    }
    const directory = path.resolve(args.repository ?? context.worktree ?? context.directory ?? '.');
    const repository = (await git(directory, ['rev-parse', '--show-toplevel'])).trim();
    const base = await commit(repository, args.baseRef);
    const head = args.headRef ? await commit(repository, args.headRef) : ':working';
    const before = await snapshot(repository, base, head);
    temp = await mkdtemp(path.join(tmpdir(), 'opencode-review-'));
    const requirementsPath = path.join(temp, 'requirements.md');
    const requestPath = path.join(temp, 'request.json');
    await writeFile(requirementsPath, args.requirements, { mode: 0o600 });
    await writeFile(requestPath, JSON.stringify({ schema: 'review.request/v1', repository_path: repository,
      base_ref: base, head_ref: head, requirements: requirementsPath }), { mode: 0o600 });
    const model = args.model ?? process.env.REVIEW_MODEL ?? 'opencode/gpt-5.6-terra';
    if (typeof model !== 'string' || !model.trim()) throw new Error('Review model must be nonempty');
    const executable = options.executable ?? process.env.REVIEW_CLI_BIN ?? 'review-cli';
    const cliArgs = [...(options.prefixArgs ?? []), 'run', '--request', requestPath, '--format', 'json',
      '--model', model, '--max-turns', String(maxTurns), '--wall-clock-budget-secs', String(budget)];
    const output = await run(executable, cliArgs, { cwd: repository, signal: context.abort, timeout: (budget + 10) * 1000 });
    const result = validate(JSON.parse(output.stdout), output.code);
    if (await snapshot(repository, base, head) !== before) throw new Error('Repository changed during review; rerun checks and review');
    return { ...result, repository, baseRef: base, headRef: head, snapshot: before, model,
      blockingFindings: result.findings.filter((f) => f.blocking),
      suggestions: result.findings.filter((f) => !f.blocking) };
  } catch (error) {
    return { schema: 'opencode.review.error/v1', status: 'ERROR',
      reason: error.code === 'ENOENT' ? 'EXECUTABLE_NOT_FOUND' : 'REVIEW_FAILED', message: error.message };
  } finally {
    if (temp) await rm(temp, { recursive: true, force: true });
  }
}

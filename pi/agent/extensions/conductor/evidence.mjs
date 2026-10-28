// Local, content-addressed receipts. No task selection, lifecycle writes or retries.
import { verificationChecks } from './verification.mjs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstat, mkdir, readFile, writeFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { implementationTree } from './git-tree.mjs';

export const digest = value => createHash('sha256').update(value).digest('hex');
const git = (repository, args) => execFileSync('git', args, {
  cwd: repository, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, windowsHide: true,
});
const scope = ['--', '.', ':(exclude).scaffold'];

export function validateBinding(binding) {
  if (!binding || Object.keys(binding).some(k => !['featureId', 'taskId', 'designRef'].includes(k)) ||
      ['featureId', 'taskId', 'designRef'].some(k => typeof binding[k] !== 'string' || !binding[k].trim())) {
    throw new Error('task requires featureId, taskId and designRef');
  }
}

// Include index, working diff and nonignored untracked contents. Scaffold state
// is bookkeeping, excluded from the implementation baseline. Ignored build
// artifacts are intentionally outside this recovery fingerprint.
export async function snapshot(repository) {
  const status = git(repository, ['status', '--porcelain=v1', '-z', '--untracked-files=all', ...scope]);
  const untracked = git(repository, ['ls-files', '--others', '--exclude-standard', '-z', ...scope])
    .split('\0').filter(Boolean).sort();
  const files = [];
  for (const name of untracked) {
    const stat = await lstat(path.join(repository, name));
    if (!stat.isFile()) throw new Error('Cannot fingerprint nonregular untracked file: ' + name);
    files.push([name, digest(await readFile(path.join(repository, name)))]);
  }
  return { tree: await implementationTree(repository), head: git(repository, ['rev-parse', 'HEAD']).trim(), clean: !status,
    bookkeepingVisible: !!git(repository, ['status', '--porcelain=v1', '--untracked-files=all', '--', '.scaffold']).trim(),
    digest: digest(JSON.stringify([status,
      git(repository, ['diff', '--binary', '--no-ext-diff', '--no-textconv', 'HEAD', ...scope]),
      git(repository, ['diff', '--cached', '--binary', '--no-ext-diff', '--no-textconv', ...scope]), files])) };
}

async function directory(repository, create = false) {
  const dir = path.resolve(repository, git(repository, ['rev-parse', '--git-path', 'pi-conductor-evidence']).trim());
  try {
    const stat = await lstat(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Evidence directory must be a regular directory');
  } catch (error) {
    if (error.code !== 'ENOENT' || !create) throw error;
    await mkdir(dir, { mode: 0o700 });
  }
  return dir;
}

export async function retainEvidence(repository, record) {
  const bytes = JSON.stringify({ schema: 'pi.task-attempt/v1', recordedAt: new Date().toISOString(), ...record });
  const hash = digest(bytes);
  const dir = await directory(repository, true);
  await writeFile(path.join(dir, hash + '.json'), bytes, { flag: 'wx', mode: 0o600 });
  return 'pi-evidence:sha256:' + hash;
}

export async function readEvidence(repository, reference) {
  const match = /^pi-evidence:sha256:([a-f0-9]{64})$/.exec(reference ?? '');
  if (!match) throw new Error('Invalid evidence reference');
  const file = path.join(await directory(repository), match[1] + '.json');
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Evidence must be a regular file');
  const bytes = await readFile(file, 'utf8');
  if (digest(bytes) !== match[1]) throw new Error('Evidence digest mismatch');
  const record = JSON.parse(bytes);
  if (record.schema !== 'pi.task-attempt/v1' ||
      await realpath(record.repository) !== await realpath(repository)) {
    throw new Error('Evidence schema or repository mismatch');
  }
  validateBinding(record.task);
  return record;
}

// Structural success is necessary, never proof that meaningful tests ran. Pi
// must also inspect check output and the independently produced review content.
export function verifiedResult(result, args) {
  let checks;
  try { checks = args ? verificationChecks(args) : [{ name: 'build' }, { name: 'test' }]; }
  catch { return false; }
  const c = result?.conductor;
  return result?.status === 'PASSED' && c?.schema === 'conductor.result/v1' &&
    c.status === 'PASSED' && c.phase === 'review' && !c.error &&
    c.execution?.success === true && Array.isArray(c.checks) && c.checks.length === checks.length &&
    checks.every((check, index) => c.checks[index]?.name === check.name && c.checks[index].exit_code === 0) &&
    c.review?.status === 'APPROVED';
}

export async function inspectEvidence(reference, context) {
  try {
    const repository = path.resolve(git(context.directory, ['rev-parse', '--show-toplevel']).trim());
    const record = await readEvidence(repository, reference);
    const current = await snapshot(repository);
    return { ok: true, reference, record, current,
      matchesWorkingTree: current.head === record.after?.head && current.digest === record.after?.digest,
      structurallyVerified: verifiedResult(record.result, record.args) };
  } catch (error) { return { ok: false, message: error.message }; }
}

// Separate namespace: task receipt readers can never accept feature-shaped records.
export async function retainFeatureEvidence(repository, record) {
  const bytes = JSON.stringify({ ...record, schema: 'pi.feature-attempt/v1',
    repository, recordedAt: new Date().toISOString() });
  const hash = digest(bytes);
  await writeFile(path.join(await directory(repository, true), 'feature-' + hash + '.json'), bytes,
    { flag: 'wx', mode: 0o600 });
  return 'pi-feature-evidence:sha256:' + hash;
}
export async function readFeatureEvidence(repository, reference) {
  const match = /^pi-feature-evidence:sha256:([a-f0-9]{64})$/.exec(reference ?? '');
  if (!match) throw new Error('Invalid feature evidence reference');
  const file = path.join(await directory(repository), 'feature-' + match[1] + '.json');
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Feature evidence must be a regular file');
  const bytes = await readFile(file, 'utf8');
  if (digest(bytes) !== match[1]) throw new Error('Feature evidence digest mismatch');
  const record = JSON.parse(bytes);
  if (record.schema !== 'pi.feature-attempt/v1' || await realpath(record.repository) !== await realpath(repository))
    throw new Error('Feature evidence schema/repository mismatch');
  return record;
}
export async function featureEvidenceReferences(repository) {
  const { readdir } = await import('node:fs/promises');
  let dir;
  try { dir = await directory(repository); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return (await readdir(dir)).filter(f => /^feature-[a-f0-9]{64}\.json$/.test(f))
    .map(f => 'pi-feature-evidence:sha256:' + f.slice(8, -5));
}

// Read-only discovery for recovery and stale-attempt protection across rebase epochs.
export async function taskEvidenceReferences(repository) {
  const { readdir } = await import('node:fs/promises');
  let dir;
  try { dir = await directory(repository); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return (await readdir(dir)).filter(f => /^[a-f0-9]{64}\.json$/.test(f))
    .map(f => 'pi-evidence:sha256:' + f.slice(0, -5));
}

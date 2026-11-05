// Git-native implementation snapshots; never borrow or mutate the user's index.
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, copyFile, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export function git(repository, args, options = {}) {
  return execFileSync('git', args, { cwd: repository, encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'], timeout: 30000, maxBuffer: 32 * 1024 * 1024, windowsHide: true,
    ...options, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', ...options.env } }).trimEnd();
}
export async function withTreeIndex(repository, base, action) {
  const dir = await mkdtemp(path.join(tmpdir(), 'pi-checkpoint-'));
  const index = path.join(dir, 'index');
  const env = { GIT_INDEX_FILE: index };
  try {
    git(repository, ['read-tree', base], { env });
    return await action(env, index);
  } finally { await rm(dir, { recursive: true, force: true }); }
}
export async function implementationTree(repository, base = 'HEAD') {
  return withTreeIndex(repository, base, async env => {
    // Submodules, conflicts and hidden tracked edits cannot be represented safely.
    const entries = git(repository, ['ls-files', '--stage', '-z']);
    if (entries.split('\0').some(e => /^(160000|\d+ [a-f0-9]+ [123])/.test(e)))
      throw new Error('Submodules or unresolved index entries are unsupported');
    if (git(repository, ['ls-files', '-v', '-z']).split('\0').some(e => /^[a-zS]/.test(e)))
      throw new Error('Assume-unchanged and sparse/skip-worktree entries are unsupported');
    if (git(repository, ['ls-files', '-z', '--', '.scaffold']))
      throw new Error('Scaffold bookkeeping must be ignored and untracked');
    git(repository, ['add', '-A', '--', '.'], { env });
    return git(repository, ['write-tree'], { env });
  });
}

export async function currentIndexTree(repository, indexPath) {
  return withTreeIndex(repository, 'HEAD', async (env, privateIndex) => {
    await copyFile(indexPath, privateIndex);
    return git(repository, ['write-tree'], { env });
  });
}

export async function assertNoGitOperation(repository) {
  for (const name of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'BISECT_LOG']) {
    const file = path.resolve(repository, git(repository, ['rev-parse', '--git-path', name]));
    try { await lstat(file); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    throw new Error('Git operation in progress: ' + name);
  }
}

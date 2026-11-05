import { git } from "./tree.mjs";
const requireValue = (ok, message) => { if (!ok) throw new Error(message); };
const sha = value => /^[a-f0-9]{40}$/.test(value ?? "");
// Git object writes only: no checkout, real-index change, stash, hooks or branch move.
// A conflict or any extra/missing source edit is deliberately not guessed away.
export const recoveryCommitEnvironment = { GIT_AUTHOR_NAME: 'Pi Recovery', GIT_AUTHOR_EMAIL: 'pi-recovery@localhost',
  GIT_COMMITTER_NAME: 'Pi Recovery', GIT_COMMITTER_EMAIL: 'pi-recovery@localhost',
  GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z' };

export function rebasedAttemptTree(repository, previous, head) {
  const sourceCommit = git(repository, ['commit-tree', previous.after.tree, '-p', previous.after.head],
    { input: 'Pi interrupted task source snapshot\n', env: recoveryCommitEnvironment });
  // A retained HEAD_CHANGED terminal receipt already snapshots the dirty tree
  // on the new HEAD. Preserve that exact tree; never replay or merge it twice.
  if (previous.after.head === head && previous.result.status === 'BLOCKED' && previous.result.reason === 'HEAD_CHANGED')
    return { tree: previous.after.tree, sourceCommit };
  requireValue(previous.after.head === previous.args.baseRef, 'Receipt crossed an unrelated Git revision');
  const merged = git(repository, ['merge-tree', '--write-tree', '--merge-base=' + previous.args.baseRef, head, sourceCommit]);
  const tree = merged.split('\n')[0];
  requireValue(sha(tree), 'Cannot deterministically transplant the retained task tree');
  return { tree, sourceCommit };
}

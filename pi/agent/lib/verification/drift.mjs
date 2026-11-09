// Read-only classification of how Git relates to the history the ledger recorded.
// Never mutates Git or Scaffold; it only names the applicable recovery.
import { git, assertNoGitOperation } from '../git/tree.mjs';
import { snapshot } from '../git/snapshot.mjs';
import { verifyHistory } from './history.mjs';

const tryGit = (repository, args) => { try { return git(repository, args); } catch { return undefined; } };

export async function inspectFeatureDrift(repository, feature) {
  const out = (state, summary, recommendation, details = {}) => ({ ok: true, state, summary, recommendation,
    details: { ...details, upstream: upstream(repository) } });
  try { await assertNoGitOperation(repository); }
  catch (error) { return out('git-operation-in-progress', error.message,
    'Finish or abort the Git operation. If it was a rebase of the feature branch, rewrite_feature_history records it between tasks (suspend any active task first).'); }
  const branch = tryGit(repository, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (branch !== feature.branch) return out('branch-mismatch', 'Current branch ' + branch + ', feature branch ' + feature.branch,
    'Switch to the feature branch; approval and execution never switch branches.');
  const head = git(repository, ['rev-parse', 'HEAD']);
  const reachable = head === feature.head || tryGit(repository, ['merge-base', '--is-ancestor', feature.head, head]) !== undefined;
  if (!reachable)
    return out('rewritten-history', 'The ledger\'s recorded head ' + feature.head + ' is not reachable from HEAD.',
      'History was rewritten (rebase or amend). Use rewrite_feature_history between tasks (suspend any active task first); adopt_foreign_commits does not apply.',
      { recordedHead: feature.head });
  try { verifyHistory(repository, feature); }
  catch (error) {
    return out('ledger-disagrees-with-git', error.message,
      'The recorded history no longer matches Git although it is reachable. Do not edit the ledger; inspect the difference.');
  }
  const snap = await snapshot(repository);
  if (!snap.clean || snap.bookkeepingVisible) return out('dirty-worktree', 'Source/index has uncommitted changes or Scaffold state is visible.',
    'Commit, stash or discard them yourself. If you commit them between tasks, run adopt_foreign_commits for the new HEAD.',
    { recordedHead: feature.head });
  if (head === feature.head)
    return out('authenticated', 'HEAD equals the ledger\'s recorded head and Git matches the recorded history.', 'No recovery needed.',
      { recordedHead: feature.head, segments: feature.history.length });
  const active = Object.values(feature.tasks).filter(t => t.status === 'in_progress').map(t => t.id);
  return out('foreign-commits', 'HEAD has commits after the ledger\'s recorded head ' + feature.head + ' that no checkpoint or approval covers.',
    active.length
      ? 'A task is active (' + active.join(', ') + '). Finish, block or suspend it, then record the commits between tasks.'
      : 'Run adopt_foreign_commits with fromRef ' + feature.head + ' and toRef ' + head + '.',
    { recordedHead: feature.head, activeTasks: active });
}

// Advisory only: an upstream that moved never invalidates execution by itself.
function upstream(repository) {
  const remote = tryGit(repository, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  const behind = remote && tryGit(repository, ['rev-list', '--count', 'HEAD..' + remote]);
  return remote && behind !== undefined ? { ref: remote, behind: Number(behind), advisory: 'Integrate between tasks by rebasing, then reconcile; validate the integrated tree before merging.' } : null;
}

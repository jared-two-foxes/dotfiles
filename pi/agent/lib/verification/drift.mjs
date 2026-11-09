// Read-only classification of how Git history relates to the authenticated feature
// boundary. Never mutates Git, Scaffold or evidence; it only names the applicable recovery.
import { git, assertNoGitOperation } from '../git/tree.mjs';
import { snapshot } from '../git/snapshot.mjs';
import { checkpointHistory } from './checkpoint-history.mjs';
import { findAdoption, adoptionEligibility } from './baseline-adoption.mjs';

const tryGit = (repository, args) => { try { return git(repository, args); } catch { return undefined; } };

export async function inspectFeatureDrift(repository, feature, context = {}) {
  const out = (state, summary, recommendation, details = {}) => ({ ok: true, state, summary, recommendation,
    details: { ...details, upstream: upstream(repository) } });
  try { await assertNoGitOperation(repository); }
  catch (error) { return out('git-operation-in-progress', error.message,
    'Finish or abort the Git operation. After an interrupted task rebase use recover_interrupted_task_rebase.'); }
  const branch = tryGit(repository, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (branch !== feature.branch) return out('branch-mismatch', 'Current branch ' + branch + ', feature branch ' + feature.branch,
    'Switch to the feature branch; approval and execution never switch branches.');
  const head = git(repository, ['rev-parse', 'HEAD']);
  if (tryGit(repository, ['merge-base', '--is-ancestor', feature.original_baseline, head]) === undefined)
    return out('rewritten-history', 'The original baseline is not an ancestor of HEAD.',
      'History was rewritten (rebase). Use reconcile_feature_rebase between tasks; baseline adoption does not apply.');
  let adoption;
  try { adoption = await findAdoption(repository, feature); }
  catch (error) { return out('corrupt-adoption-evidence', error.message, 'Restore the retained evidence and refs; never recreate or reset the feature.'); }
  const snap = await snapshot(repository);
  if (!snap.clean || snap.bookkeepingVisible) return out('dirty-worktree', 'Source/index has uncommitted changes or Scaffold state is visible.',
    'Commit, stash or discard them yourself. If you commit them before any task started, run adopt_feature_baseline for the new HEAD.',
    { adoption: adoption?.reference ?? null });
  try {
    const checkpoints = await checkpointHistory(repository, feature, { head, baseline: feature.original_baseline, branch: feature.branch });
    return out('authenticated', 'HEAD is reachable through the authenticated boundary' + (adoption ? ' (adopted baseline ' + adoption.baseline + ')' : '') + '.',
      'No recovery needed.', { checkpoints: checkpoints.length, adoption: adoption?.reference ?? null });
  } catch (error) {
    const eligibility = await adoptionEligibility({ featureId: feature.id, originalBaseRef: feature.original_baseline, newBaseRef: head }, { feature }, context);
    return out('foreign-commits', 'HEAD contains commits that are not authenticated task checkpoints: ' + error.message,
      eligibility.eligible
        ? 'No task has started: run adopt_feature_baseline with originalBaseRef ' + feature.original_baseline + ' and newBaseRef ' + head + '.'
        : 'Baseline adoption is unavailable (' + eligibility.reasons.join('; ') + '). Adoption of commits made after work began is not supported yet; do not edit state or recreate the feature.',
      { adoption: adoption?.reference ?? null, adoptionEligible: eligibility.eligible, adoptionBlockers: eligibility.reasons });
  }
}

// Advisory only: an upstream that moved never invalidates execution by itself.
function upstream(repository) {
  const remote = tryGit(repository, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  const behind = remote && tryGit(repository, ['rev-list', '--count', 'HEAD..' + remote]);
  return remote && behind !== undefined ? { ref: remote, behind: Number(behind), advisory: 'Integrate between tasks by rebasing, then reconcile_feature_rebase; validate the integrated tree before merging.' } : null;
}

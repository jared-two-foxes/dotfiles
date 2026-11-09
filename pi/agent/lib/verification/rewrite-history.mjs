// Map the ledger's recorded history onto the commits of a rebased branch.
//
// After the user rebases the feature branch onto a new upstream commit, every recorded checkpoint
// and foreign commit exists again as a new commit, in the same order, on top of the new base.
// This function derives the replacement segment list from Git so Scaffold can record it. It decides
// nothing about whether the rebased tree is *correct*; the caller runs the full checks and an
// independent review before recording the rewrite.
import { git } from '../git/tree.mjs';

const requireValue = (ok, message) => { if (!ok) throw new Error(message); };
const sha = x => /^[a-f0-9]{40}$/.test(x ?? '');
const tryGit = (repository, args) => { try { return git(repository, args); } catch { return undefined; } };

export function planRewrite(repository, feature, { upstreamBaseRef, headRef }) {
  requireValue(sha(upstreamBaseRef) && sha(headRef), 'The new base and the current HEAD must be full SHAs');
  requireValue(tryGit(repository, ['merge-base', '--is-ancestor', upstreamBaseRef, headRef]) !== undefined,
    'The new base is not an ancestor of HEAD; rebase the feature branch onto it first');
  const commits = git(repository, ['rev-list', '--reverse', upstreamBaseRef + '..' + headRef]).split('\n').filter(Boolean);
  const recorded = feature.history.reduce((n, s) => n + (s.kind === 'checkpoint' ? 1 : s.commits.length), 0);
  requireValue(commits.length === recorded,
    'The rebased branch has ' + commits.length + ' commit(s) above the new base but the ledger recorded ' + recorded +
    '. A rebase must keep every recorded commit: none dropped, squashed, split or added');
  let previous = upstreamBaseRef;
  const take = () => {
    const commit = commits.shift();
    const parents = git(repository, ['show', '-s', '--format=%P', commit]).split(' ').filter(Boolean);
    requireValue(parents.length === 1 && parents[0] === previous,
      'Commit ' + commit + ' is not a single-parent continuation of ' + previous + '; merges are not supported in a rewrite');
    return { commit, parents };
  };
  const history = [];
  for (const segment of feature.history) {
    if (segment.kind === 'checkpoint') {
      const { commit } = take();
      const message = git(repository, ['show', '-s', '--format=%B', commit]);
      requireValue(message.split('\n').includes('Pi-Checkpoint: ' + segment.task_id),
        'Commit ' + commit + ' is not the checkpoint of task ' + segment.task_id + ' (missing Pi-Checkpoint trailer, or reordered)');
      history.push({ kind: 'checkpoint', task_id: segment.task_id, commit, parent: previous, tree: git(repository, ['rev-parse', commit + '^{tree}']) });
      previous = commit;
    } else {
      const from = previous, items = [];
      for (const old of segment.commits) {
        requireValue(old.parents.length === 1, 'A recorded foreign range with merge commits cannot be mapped onto a rebase');
        const { commit, parents } = take();
        const subject = git(repository, ['show', '-s', '--format=%s', commit]).slice(0, 200);
        requireValue(subject === old.subject, 'Commit ' + commit + ' ("' + subject + '") does not match the recorded commit "' + old.subject + '"');
        items.push({ commit, parents, subject });
        previous = commit;
      }
      history.push({ kind: 'foreign', from, to: previous, source: segment.source, commits: items, approval: segment.approval });
    }
  }
  return { history, newHead: previous, newBase: upstreamBaseRef };
}

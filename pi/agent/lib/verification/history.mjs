// Verify Git against the history the Scaffold ledger recorded (feature.history / feature.head).
//
// Scaffold guarantees the recorded segments form one unbroken chain from the original
// baseline. This module confirms that Git agrees. Each commit between the baseline and the
// recorded head is either a recorded task checkpoint (parent and tree match) or inside a
// recorded foreign range (a user-approved set of commits that are NOT verified task work).
import { isDeepStrictEqual as equal } from 'node:util';
import { git } from '../git/tree.mjs';

const requireValue = (ok, message) => { if (!ok) throw new Error(message); };
const parentsOf = (repository, commit) => git(repository, ['show', '-s', '--format=%P', commit]).split(' ').filter(Boolean);
const treeOf = (repository, commit) => git(repository, ['rev-parse', commit + '^{tree}']);
const MAX_RANGE = 200;

/** Commits in from..to, oldest first, with parents and subjects, for a foreign-history record. */
export function commitRange(repository, from, to) {
  const commits = git(repository, ['rev-list', '--reverse', from + '..' + to]).split('\n').filter(Boolean);
  requireValue(commits.length > 0 && commits.length <= MAX_RANGE, 'Foreign history needs 1..' + MAX_RANGE + ' commits');
  return commits.map(commit => ({ commit, parents: parentsOf(repository, commit),
    subject: git(repository, ['show', '-s', '--format=%s', commit]).slice(0, 200) }));
}

/**
 * Confirm Git matches the ledger from the original baseline to the recorded head.
 * With `head`, also require HEAD to equal the recorded head (no unrecorded commits). Without it
 * this proves only that the recorded chain exists in Git, not that HEAD is on it, so execution
 * and checkpointing always pass `head`.
 */
export function verifyHistory(repository, feature, { head } = {}) {
  requireValue(Array.isArray(feature.history) && /^[a-f0-9]{40}$/.test(feature.head ?? ''),
    'Scaffold did not report recorded history; Scaffold ledger schema 3 required');
  if (head !== undefined)
    requireValue(head === feature.head,
      'HEAD ' + head + ' differs from the ledger\'s recorded head ' + feature.head +
      ': commits exist that the ledger has not recorded. Run inspect_feature_drift');
  let cursor = feature.head;
  for (const segment of [...feature.history].reverse()) {
    if (segment.kind === 'checkpoint') {
      requireValue(cursor === segment.commit, 'Recorded checkpoint ' + segment.commit + ' is not where Git history continues');
      const parents = parentsOf(repository, cursor);
      requireValue(parents.length === 1 && parents[0] === segment.parent, 'Checkpoint ' + cursor + ' does not have its recorded parent');
      requireValue(treeOf(repository, cursor) === segment.tree, 'Checkpoint ' + cursor + ' tree differs from the ledger');
      cursor = segment.parent;
    } else {
      requireValue(segment.kind === 'foreign' && cursor === segment.to, 'Recorded foreign range does not end where Git history continues');
      const actual = commitRange(repository, segment.from, segment.to);
      requireValue(equal(actual, segment.commits), 'Foreign range ' + segment.from + '..' + segment.to + ' no longer matches the ledger');
      cursor = segment.from;
    }
  }
  requireValue(cursor === (feature.base ?? feature.original_baseline), 'Recorded history does not lead back to its base');
  return feature.history;
}

/** Requirements text that keeps recorded foreign ranges in the final reviewer's scope. */
export function foreignHistoryRequirements(feature) {
  const ranges = (feature.history ?? []).filter(s => s.kind === 'foreign');
  if (!ranges.length) return '';
  return '\n\nFOREIGN COMMITS RECORDED IN THE LEDGER: the user approved recording the commits below. They are NOT task checkpoints ' +
    'and were NOT verified by task review; they are part of this review scope (original baseline..HEAD). ' +
    'Assess them for feature-relevant changes, regressions and interactions:\n' +
    ranges.map(r => 'Range ' + r.from + '..' + r.to + ' (' + r.source + ')\n' +
      r.commits.map(c => '- ' + c.commit + ' ' + c.subject).join('\n')).join('\n');
}

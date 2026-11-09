// Record user-approved commits that are not task checkpoints (for example after the user
// commits unrelated files) as a `history-foreign` ledger entry. Nothing is rewritten: the
// original baseline, authorization and designs stay as they are, and the recorded commits are
// never treated as verified. They remain in final-validation review scope.
import path from 'node:path';
import { isDeepStrictEqual as equal } from 'node:util';
import { git, assertNoGitOperation } from '../git/tree.mjs';
import { snapshot } from '../git/snapshot.mjs';
import { approved } from '../authorization/feature.mjs';
import { commitRange, verifyHistory } from './history.mjs';

const requireValue = (ok, message) => { if (!ok) throw new Error(message); };
const sha = x => /^[a-f0-9]{40}$/.test(x ?? '');
const MAX_PATHS = 500;
const tryGit = (repository, args) => { try { return git(repository, args); } catch { return undefined; } };

function derive(args, feature, context) {
  context.abort?.throwIfAborted();
  const repository = path.resolve(git(context.directory, ['rev-parse', '--show-toplevel']));
  requireValue(sha(args.fromRef) && sha(args.toRef), 'The recorded head and the new head must be full SHAs');
  requireValue(feature?.id === args.featureId, 'Cannot inspect feature');
  requireValue(feature.head === args.fromRef,
    'Recorded head mismatch: the ledger records ' + feature.head + ', received ' + args.fromRef);
  return { repository };
}

async function preconditions(args, feature, context) {
  const { repository } = derive(args, feature, context);
  await assertNoGitOperation(repository);
  const branch = git(repository, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  requireValue(branch === feature.branch, 'Branch mismatch: current ' + branch + ', feature ' + feature.branch);
  const head = git(repository, ['rev-parse', 'HEAD']);
  requireValue(head === args.toRef, 'Stale HEAD: current ' + head + ', approval names ' + args.toRef);
  requireValue(head !== args.fromRef, 'HEAD already equals the recorded head; nothing to record');
  requireValue(tryGit(repository, ['merge-base', '--is-ancestor', args.fromRef, head]) !== undefined,
    'The recorded head is not an ancestor of HEAD (history was rewritten). This is not rebase recovery');
  requireValue(approved(feature), 'Approve the feature direction before recording history');
  requireValue(!Object.values(feature.tasks).some(t => t.status === 'in_progress'), 'Record foreign commits only between tasks');
  verifyHistory(repository, feature);
  const before = await snapshot(repository);
  requireValue(before.clean && !before.bookkeepingVisible && before.head === head,
    'Recording requires a clean source tree and index with Scaffold state ignored');
  const commits = commitRange(repository, args.fromRef, head);
  requireValue(!commits.some(c => /^Pi-Checkpoint: /m.test(git(repository, ['show', '-s', '--format=%B', c.commit]))),
    'The range contains task checkpoint commits that the ledger has not recorded');
  const paths = git(repository, ['diff', '--name-only', '-z', args.fromRef, head]).split('\0').filter(Boolean);
  const scope = { repository, featureId: feature.id, instanceId: feature.workflow.instance_id, designRef: feature.design_ref,
    branch, from: args.fromRef, to: head, source: 'user-commits', commits,
    fromTree: git(repository, ['rev-parse', args.fromRef + '^{tree}']), toTree: git(repository, ['rev-parse', head + '^{tree}']),
    changedPaths: paths.slice(0, MAX_PATHS), pathsTruncated: paths.length > MAX_PATHS };
  return { repository, scope, taskRevision: feature.task_revision, before };
}

/**
 * `readFeature()` re-reads the feature through Scaffold. `confirm(scope)` is a trusted user
 * approval. `store(artifact)` returns a ledger reference; `record(payload)` appends the entry.
 */
export async function adoptForeignCommits(args, { readFeature, store, record }, context = {}, options = {}) {
  try {
    let feature = await readFeature();
    // Idempotent: a repeat, or a retry after a lost response, needs no clean tree or preconditions.
    const existing = feature.history?.find(s => s.kind === 'foreign' && s.from === args.fromRef && s.to === args.toRef);
    if (existing) return { ok: true, status: 'RECORDED', recovered: true, from: existing.from, to: existing.to, commits: existing.commits };
    const first = await preconditions(args, feature, context);
    requireValue(await options.confirm?.(first.scope) === true, 'Explicit user approval of these commits is required');
    context.abort?.throwIfAborted();
    feature = await readFeature();
    const second = await preconditions(args, feature, context);
    requireValue(equal(first.scope, second.scope) && first.taskRevision === second.taskRevision && equal(first.before, second.before),
      'Repository or feature changed during approval; nothing was recorded');
    // Deterministic content, so a retry stores the same artifact.
    const approval = await store({ kind: 'foreign-history-approval', scope: second.scope });
    await options.interrupt?.('afterArtifact');
    const unchanged = await preconditions(args, await readFeature(), context);
    requireValue(equal(unchanged.scope, second.scope) && equal(unchanged.before, second.before),
      'Repository changed before the entry was recorded; nothing was recorded');
    await record({ from: args.fromRef, to: args.toRef, source: 'user-commits', commits: second.scope.commits, approval });
    await options.interrupt?.('afterRecord');
    return { ok: true, status: 'RECORDED', from: args.fromRef, to: args.toRef, commits: second.scope.commits, approval, scope: second.scope };
  } catch (error) {
    return { ok: false, status: 'BLOCKED', message: error.message,
      recovery: 'Nothing was changed in Scaffold or Git history. Inspect with inspect_feature_drift; retry only with the exact recorded head and new head you approve.' };
  }
}

// One explicit local checkpoint, never task selection, source editing or publishing.
import { sameVerification } from './verification.mjs';
import { open, readFile, rename, unlink, lstat } from 'node:fs/promises';
import path from 'node:path';
import { git, implementationTree, withTreeIndex, currentIndexTree, assertNoGitOperation } from './git-tree.mjs';
import { validateBinding, readEvidence, snapshot, verifiedResult } from './evidence.mjs';
import { scaffoldTasks } from '../scaffold/adapter.mjs';
const requireValue = (ok, message) => { if (!ok) throw new Error(message); };
const sha = x => /^[a-f0-9]{40}$/.test(x ?? '');

// Only a trusted UI confirmation callback can create a grant. No model-supplied
// approval flag or persisted conversation text is interpreted as authorization.
export function checkpointAuthorization(confirm) {
  const grants = new Set();
  let epoch = 0;
  const authorize = async (scope, mode) => {
    const startedEpoch = epoch;
    requireValue(['manual', 'feature'].includes(mode), 'Choose manual or feature checkpoint authorization');
    const key = JSON.stringify(scope);
    if (grants.has(key)) return true;
    const approved = await confirm('Authorize local task checkpoints',
      JSON.stringify(scope, null, 2) + '\n' + (mode === 'feature'
        ? 'Allow local commits for successfully verified tasks in this feature for this Pi session?'
        : 'Allow this one verified task checkpoint?') +
      '\nThis grants no source execution, push, merge, destructive operation or protected-branch permission.');
    if (startedEpoch !== epoch) return false;
    if (approved && mode === 'feature') grants.add(key);
    return approved === true;
  };
  authorize.reset = () => { grants.clear(); epoch++; };
  return authorize;
}

// Shared authentication for task checkpoints and cumulative feature validation.
export async function authenticateTaskEvidence(repository, reference, binding) {
  const record = await readEvidence(repository, reference);
  requireValue(['featureId', 'taskId', 'designRef'].every(k => record.task[k] === binding[k]), 'Task/design identity mismatch');
  // Authenticate the retained request against the caller's full plan. The final
  // command is transparently wrapped to capture the source/index review boundary.
  const requestChecks = record.request?.checks;
  requireValue(Array.isArray(requestChecks) && requestChecks.length > 0, 'Missing requested verification plan');
  const requestedPlan = requestChecks.map((check, index) => ({
    name: check.name,
    command: index === requestChecks.length - 1
      ? JSON.parse(check.args[1]).command : [check.program, ...check.args],
  }));
  requireValue(sameVerification(record.args, { checks: requestedPlan }), 'Retained request verification plan mismatch');
  requireValue(verifiedResult(record.result, record.args) && record.before?.head === record.args?.baseRef &&
    record.after?.head === record.before.head && sha(record.after?.tree) && record.request?.review?.base_ref === record.before.head &&
    record.request?.review?.requirements === record.args.requirements &&
    record.reviewSnapshot?.head === record.after.head && record.reviewSnapshot?.tree === record.after.tree &&
    record.reviewSnapshot?.digest === record.after.digest && !record.reviewSnapshot?.bookkeepingVisible &&
    record.response?.code === 0 &&
    verifiedResult({ status: 'PASSED', conductor: JSON.parse(record.response.stdout) }, record.args), 'Missing successful task-bound verification or Git tree (legacy receipts require new verification)');
  // Prove the correction chain began clean and never changed task or baseline.
  let first = record;
  const seen = new Set();
  while (first.args.previousAttempt) {
    requireValue(!seen.has(first.args.previousAttempt), 'Cyclic receipt chain'); seen.add(first.args.previousAttempt);
    const prior = await readEvidence(repository, first.args.previousAttempt);
    requireValue(prior.attempt + 1 === first.attempt && prior.attempt < 5 &&
      ['featureId', 'taskId', 'designRef'].every(k => prior.task[k] === record.task[k]) &&
      prior.args.baseRef === record.args.baseRef && prior.args.requirements === record.args.requirements &&
      sameVerification(prior.args, record.args) &&
      prior.result.status !== 'PASSED' && prior.before.head === record.args.baseRef && prior.after.head === record.args.baseRef &&
      prior.after.digest === first.before.digest, 'Invalid correction receipt chain');
    first = prior;
  }
  requireValue(first.attempt === 1 && first.before.clean && first.before.tree === git(repository, ['rev-parse', record.args.baseRef + '^{tree}']), 'Task did not start from a clean isolated baseline');
  return record;
}

export async function checkpointVerifiedTask(args, context = {}, options = {}) {
  let lock, lockPath, repository;
  try {
    context.abort?.throwIfAborted();
    validateBinding(args?.task);
    requireValue(sha(args.featureBaseRef), 'featureBaseRef must be the original full feature baseline');
    requireValue(typeof args.defaultBranch === 'string' && args.defaultBranch.trim(), 'Known repository defaultBranch is required');
    requireValue(Array.isArray(args.protectedBranches) && args.protectedBranches.every(x => typeof x === 'string'), 'List all known additional protectedBranches (or [])');
    repository = path.resolve(git(context.directory, ['rev-parse', '--show-toplevel']));
    await assertNoGitOperation(repository);
    const branch = git(repository, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    const protectedBranches = [...new Set(['main', 'master', args.defaultBranch, ...args.protectedBranches])].sort();
    let remoteDefault;
    try { remoteDefault = git(repository, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']).replace(/^origin\//, ''); } catch {}
    requireValue(!protectedBranches.includes(branch) && branch !== remoteDefault, 'Protected branch checkpoint prohibited');
    requireValue(branch === args.branch, 'Current branch differs from authorized feature branch');
    const scope = { repository, branch, ...args.task, featureBaseRef: args.featureBaseRef, protectedBranches };
    // A feature grant deliberately excludes taskId, while binding feature/design/repository/branch/baseline.
    const { taskId, ...featureScope } = scope;
    const record = await authenticateTaskEvidence(repository, args.evidenceRef, args.task);
    const state = await scaffoldTasks({ operation: 'list', feature_id: args.task.featureId }, { directory: repository }, options.scaffoldOptions);
    const feature = state.data?.feature;
    const task = feature?.tasks?.[args.task.taskId];
    requireValue(state.ok && feature.design_ref === args.task.designRef && task?.status === 'completed' &&
      task.history.some(h => h.evidence?.reference === args.evidenceRef && h.evidence?.source === 'conductor' &&
        h.evidence?.result === 'PASSED' && h.evidence?.feature_id === args.task.featureId && h.evidence?.task_id === args.task.taskId),
    'Scaffold must record completion with matching Conductor evidence');
    git(repository, ['merge-base', '--is-ancestor', args.featureBaseRef, record.args.baseRef]);
    if (record.args.baseRef !== args.featureBaseRef) {
      const previousMessage = git(repository, ['show', '-s', '--format=%B', record.args.baseRef]);
      const trailer = previousMessage.split('\n').find(line => line.startsWith('Pi-Task-Checkpoint: '));
      const previous = JSON.parse(trailer?.slice('Pi-Task-Checkpoint: '.length) ?? 'null');
      requireValue(previous?.schema === 'pi.task-checkpoint/v1' && previous.featureId === args.task.featureId &&
        previous.designRef === args.task.designRef && previous.featureBaseRef === args.featureBaseRef && previous.branch === branch,
      'Feature baseline or checkpoint lineage mismatch');
    }
    const provenance = { schema: 'pi.task-checkpoint/v1', ...args.task, evidenceRef: args.evidenceRef,
      featureBaseRef: args.featureBaseRef, baseRef: record.args.baseRef, tree: record.after.tree, branch };
    const message = 'Checkpoint verified task ' + args.task.taskId.replace(/[\r\n]/g, ' ') +
      '\n\nPi-Task-Checkpoint: ' + JSON.stringify(provenance) + '\n';
    // Lock the real index before any mutation. Existing locks are never removed.
    const indexPath = path.resolve(repository, git(repository, ['rev-parse', '--git-path', 'index']));
    requireValue(!(await lstat(indexPath)).isSymbolicLink(), 'Symlink index prohibited');
    lockPath = indexPath + '.lock';
    lock = await open(lockPath, 'wx', 0o600);
    const head = git(repository, ['rev-parse', 'HEAD']);
    const current = await snapshot(repository);
    requireValue(!current.bookkeepingVisible, 'Scaffold state must be ignored and untracked');
    const indexTree = await currentIndexTree(repository, indexPath);
    const baselineTree = git(repository, ['rev-parse', record.args.baseRef + '^{tree}']);
    const pendingRef = 'refs/pi-checkpoints/' + args.evidenceRef.split(':').at(-1);
    let pending;
    try { pending = git(repository, ['rev-parse', '--verify', '--quiet', pendingRef]); } catch {}
    let recovered = false, commit;
    if (head !== record.args.baseRef) {
      requireValue(git(repository, ['show', '-s', '--format=%B', head]) === message.trimEnd() &&
        git(repository, ['show', '-s', '--format=%P', head]) === record.args.baseRef &&
        git(repository, ['rev-parse', head + '^{tree}']) === record.after.tree,
      'HEAD changed unexpectedly; no matching checkpoint at HEAD');
      recovered = true; commit = head;
      requireValue(indexTree === record.after.tree || (pending === head && indexTree === baselineTree),
        'Unrelated staged changes or ambiguous index after checkpoint');
    } else {
      requireValue(current.digest === record.after.digest, 'Current source/index differs from verification receipt');
      // Review uses tree-to-workdir, not the index. A divergent staged variant is unverified.
      requireValue(indexTree === baselineTree || indexTree === record.after.tree, 'Staged changes cannot be isolated safely');
    }
    requireValue(await implementationTree(repository, record.args.baseRef) === record.after.tree, 'Current implementation differs from verified tree');
    requireValue(await options.authorize?.(args.authorizationMode === 'feature' ? featureScope : scope, args.authorizationMode),
      'Checkpoint authorization required; obtain explicit user approval');
    context.abort?.throwIfAborted();
    await assertNoGitOperation(repository);
    requireValue(git(repository, ['symbolic-ref', '--short', 'HEAD']) === branch &&
      git(repository, ['rev-parse', 'HEAD']) === head &&
      await currentIndexTree(repository, indexPath) === indexTree &&
      await implementationTree(repository, record.args.baseRef) === record.after.tree,
      'Repository changed during checkpoint authorization');
    await options.interrupt?.('beforeCommit'); // deterministic failure injection for tests only
    // A private index stages only the exact Git tree in the receipt. No hooks,
    // filters, signing programs or source writes are run while creating the commit.
    await withTreeIndex(repository, record.after.tree, async (_env, privateIndex) => {
      await options.interrupt?.('afterStaging');
      if (!commit) {
        const date = record.recordedAt;
        commit = git(repository, ['commit-tree', record.after.tree, '-p', record.args.baseRef], {
          input: message, env: { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
        });
        // Recheck after UI interaction; update-ref is a compare-and-swap.
        requireValue(git(repository, ['symbolic-ref', '--short', 'HEAD']) === branch &&
          (await snapshot(repository)).digest === record.after.digest, 'Repository changed during authorization');
        context.abort?.throwIfAborted();
        git(repository, ['update-ref', '-m', 'Pi verified task checkpoint', '--stdin'], { input:
          'start\nupdate refs/heads/' + branch + ' ' + commit + ' ' + head +
          '\ncreate ' + pendingRef + ' ' + commit + '\nprepare\ncommit\n' });
        pending = commit;
        await options.interrupt?.('afterCommit');
      }
      // Index update is recoverable if interrupted after the atomic ref update.
      context.abort?.throwIfAborted();
      await lock.writeFile(await readFile(privateIndex));
      await lock.close(); lock = undefined;
      await rename(lockPath, indexPath); lockPath = undefined;
    });
    requireValue(git(repository, ['rev-parse', 'HEAD']) === commit && (await snapshot(repository)).clean,
      'Checkpoint created but repository changed; reconcile before next task');
    if (pending) git(repository, ['update-ref', '-d', pendingRef, commit]);
    return { ok: true, ...provenance, commit, recovered, nextBaseRef: commit };
  } catch (error) {
    return { ok: false, reason: 'CHECKPOINT_BLOCKED', message: error.message,
      ...(repository ? { repository } : {}), recovery: 'Inspect Scaffold, receipt, HEAD and index before retrying; never reset or replay blindly' };
  } finally {
    if (lock) await lock.close();
    if (lockPath && lock) await unlink(lockPath).catch(() => {});
  }
}

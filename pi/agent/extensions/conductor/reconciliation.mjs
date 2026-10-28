// Explicit verification-only recovery between tasks. Never rewrites Git or receipts.
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isDeepStrictEqual as equal } from 'node:util';
import { git, assertNoGitOperation } from './git-tree.mjs';
import { snapshot, digest, retainFeatureEvidence, readFeatureEvidence, featureEvidenceReferences } from './evidence.mjs';
import { checkpointHistory, checkpointProvenance } from './history.mjs';
import { authenticateTaskEvidence } from './task-evidence.mjs';
import { scaffoldTasks } from '../scaffold/adapter.mjs';
import { planFor, meaningful, monitorTrackedInputs, approvedDesign, featureRequirements, reviewScope,
  authenticateFeatureRecord } from './feature-verification.mjs';
import { reviewChanges } from '../review/adapter.mjs';
import { runCheck } from './feature-process.mjs';
const requireValue = (ok, message) => { if (!ok) throw new Error(message); };
const sha = x => /^[a-f0-9]{40}$/.test(x ?? '');
const result = (status, message) => ({ schema: 'pi.feature-reconciliation/v1', status, message });
const completedTasks = feature => Object.fromEntries(Object.entries(feature.tasks).filter(([, t]) => t.status === 'completed'));
const identity = feature => [feature.id, feature.design_ref, feature.context, feature.acceptance_criteria, feature.constraints ?? []];

// Retain both sides of rewritten history against Git garbage collection. These
// audit refs never move a branch, touch the index, or transfer on an ordinary push.
async function retainReconciliation(repository, record) {
  const reference = await retainFeatureEvidence(repository, record);
  const prefix = 'refs/pi-reconciliations/' + reference.split(':').at(-1);
  git(repository, ['update-ref', '--stdin'], { input: 'start\ncreate ' + prefix + '/before ' + record.oldHead +
    '\ncreate ' + prefix + '/after ' + record.binding.head + '\nprepare\ncommit\n' });
  return reference;
}

async function state(repository, featureId, options) {
  const response = await scaffoldTasks({ operation: 'list', feature_id: featureId }, { directory: repository }, options.scaffoldOptions);
  requireValue(response.ok, 'Cannot inspect Scaffold: ' + (response.message ?? 'invalid state'));
  return response.data.feature;
}
function mappedCheckpoints(repository, source, baseline, head) {
  git(repository, ['merge-base', '--is-ancestor', baseline, head]);
  const commits = git(repository, ['rev-list', '--reverse', baseline + '..' + head]).split('\n').filter(Boolean);
  requireValue(commits.length === source.length, 'Rebase dropped, squashed, duplicated or added task commits; explicit task reconciliation required');
  let parent = baseline;
  return commits.map((commit, index) => {
    const previous = source[index];
    requireValue(git(repository, ['show', '-s', '--format=%P', commit]) === parent &&
      equal(checkpointProvenance(repository, commit), checkpointProvenance(repository, previous.commit)),
    'Rebased checkpoint ordering, identity or parent mismatch');
    const mapped = { ...previous, commit, rebasedParent: parent, rebasedTree: git(repository, ['rev-parse', commit + '^{tree}']) };
    parent = commit;
    return mapped;
  });
}

async function reconciliationRequirements(repository, feature, source, originalBaseline, baseline) {
  let requirements = featureRequirements(feature, approvedDesign(repository, feature)) +
    '\n\nREBASE RECOVERY: Only the completed task prefix below is implemented; pending feature criteria remain deferred. ' +
    'Review the entire rebased completed prefix against the new upstream, including conflict resolutions, regressions and interfaces. ' +
    'Old receipts are historical and do not verify rewritten trees.\nOriginal baseline: ' + originalBaseline + '\nNew upstream baseline: ' + baseline;
  for (const checkpoint of source) {
    const evidence = await authenticateTaskEvidence(repository, checkpoint.evidenceRef,
      { featureId: feature.id, taskId: checkpoint.taskId, designRef: feature.design_ref });
    requirements += '\n\nCompleted task ' + checkpoint.taskId + ':\n' + evidence.args.requirements;
  }
  return requirements;
}

export async function readReconciliation(repository, reference, feature, args, seen = new Set()) {
  requireValue(!seen.has(reference) && seen.size < 32, 'Cyclic or excessive reconciliation chain'); seen.add(reference);
  const r = await readFeatureEvidence(repository, reference);
  requireValue(r.kind === 'reconciliation' && r.result?.schema === 'pi.feature-reconciliation/v1' && r.result.status === 'PASSED',
    'Missing successful rebase reconciliation');
  requireValue(r.binding.feature_id === feature.id && r.binding.design_ref === feature.design_ref &&
    r.originalBaseline === args.featureBaseRef && r.binding.branch === args.branch && equal(identity(r.feature), identity(feature)),
  'Reconciliation feature, design, branch or original baseline mismatch');
  for (const [id, task] of Object.entries(completedTasks(r.feature)))
    requireValue(equal(feature.tasks[id], task), 'Reconciled task changed or lost completion evidence');
  const prior = r.previousReconciliationRef
    ? await readReconciliation(repository, r.previousReconciliationRef, r.feature, args, seen) : undefined;
  const source = await checkpointHistory(repository, r.feature,
    { head: r.oldHead, baseline: r.originalBaseline, branch: args.branch, anchor: prior });
  requireValue(equal(source, r.sourceCheckpoints), 'Historical checkpoint evidence changed');
  requireValue(r.oldHead !== r.binding.head, 'No history change to reconcile');
  git(repository, ['merge-base', '--is-ancestor', prior?.baseline ?? r.originalBaseline, r.binding.baseline]);
  const checkpoints = mappedCheckpoints(repository, source, r.binding.baseline, r.binding.head);
  requireValue(equal(checkpoints, r.checkpoints), 'Rebased checkpoint mapping changed');
  const requirements = await reconciliationRequirements(repository, r.feature, source, r.originalBaseline, r.binding.baseline);
  authenticateFeatureRecord(r, r.binding, r.plan, r.feature.tasks, requirements, 'pi.feature-reconciliation/v1');
  requireValue(r.binding.tree === git(repository, ['rev-parse', r.binding.head + '^{tree}']), 'Reconciled tree changed');
  return { reference, head: r.binding.head, baseline: r.binding.baseline, checkpoints, tasks: completedTasks(r.feature), record: r };
}

export async function reconcileFeature(args, context = {}, options = {}) {
  let repository, monitor, prefixMonitor, prefixDirectory, prefixRoot, prefixBefore, record, startedReference, evidenceRef;
  try {
    context.abort?.throwIfAborted();
    const plan = planFor(args);
    requireValue(sha(args.oldHeadRef) && sha(args.upstreamBaseRef), 'Old feature HEAD and new upstream base must be full SHAs');
    repository = path.resolve(git(context.directory, ['rev-parse', '--show-toplevel']));
    const preconditions = async () => {
      await assertNoGitOperation(repository);
      requireValue(git(repository, ['symbolic-ref', '--quiet', '--short', 'HEAD']) === args.branch &&
        !['main', 'master', args.defaultBranch, ...(args.protectedBranches ?? [])].includes(args.branch), 'Feature branch changed or protected');
      requireValue(typeof args.defaultBranch === 'string' && args.defaultBranch.trim() && Array.isArray(args.protectedBranches) &&
        args.protectedBranches.every(b => typeof b === 'string'), 'Known default and protected branches required');
      let remoteDefault;
      try { remoteDefault = git(repository, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']).replace(/^origin\//, ''); } catch {}
      requireValue(args.branch !== remoteDefault, 'Default branch reconciliation prohibited');
      const before = await snapshot(repository);
      requireValue((before.clean || (options.interruptedTask && equal(before, options.interruptedTask.snapshot))) && !before.bookkeepingVisible && before.head === args.headRef, 'Reconciliation requires clean matching HEAD/index/worktree and ignored Scaffold');
      const feature = await state(repository, args.featureId, options);
      requireValue(feature.design_ref === args.designRef && (!feature.original_baseline || feature.original_baseline === args.featureBaseRef), 'Original feature identity/baseline mismatch');
      requireValue(Object.values(feature.tasks).every(t => ['pending', 'completed', 'decomposed'].includes(t.status) ||
        (t.id === options.interruptedTask?.taskId && ['in_progress', 'blocked', 'failed'].includes(t.status))),
        'Finish or explicitly recover active, blocked or failed task loops before rebasing');
      const prior = args.previousReconciliationRef
        ? await readReconciliation(repository, args.previousReconciliationRef, feature, args) : undefined;
      const source = await checkpointHistory(repository, feature,
        { head: args.oldHeadRef, baseline: args.featureBaseRef, branch: args.branch, anchor: prior });
      requireValue(args.oldHeadRef !== args.headRef, 'No history change to reconcile');
      git(repository, ['merge-base', '--is-ancestor', prior?.baseline ?? args.featureBaseRef, args.upstreamBaseRef]);
      const checkpoints = mappedCheckpoints(repository, source, args.upstreamBaseRef, args.headRef);
      return { feature, before, source, checkpoints };
    };
    const pre = await preconditions();
    const requirements = await reconciliationRequirements(repository, pre.feature, pre.source, args.featureBaseRef, args.upstreamBaseRef);
    if (args.resumeEvidenceRef) {
      const anchor = await readReconciliation(repository, args.resumeEvidenceRef, pre.feature, args);
      const r = anchor.record;
      requireValue(r.oldHead === args.oldHeadRef && r.binding.head === args.headRef && r.binding.baseline === args.upstreamBaseRef &&
        (r.previousReconciliationRef ?? null) === (args.previousReconciliationRef ?? null) && equal(r.feature, pre.feature) && equal(r.plan, plan) &&
        (options.interruptedTask ? equal(r.interruptedSource, pre.before) && r.interruptedTask === options.interruptedTask.taskId : !r.interruptedTask),
      'Retained reconciliation is stale or has a different verification plan');
      return { ...r.result, evidenceRef: args.resumeEvidenceRef, binding: r.binding, recovered: true, nextBaseRef: args.headRef };
    }
    requireValue(await options.authorize?.({ repository, originalBaseline: args.featureBaseRef, oldHead: args.oldHeadRef,
      upstreamBase: args.upstreamBaseRef, head: args.headRef, branch: args.branch, tasks: Object.keys(completedTasks(pre.feature)), plan }),
    'Explicit rebase verification authorization required');
    const unchanged = async () => {
      context.abort?.throwIfAborted(); monitor?.assert(); prefixMonitor?.assert();
      if (prefixBefore) requireValue(equal(await snapshot(prefixDirectory), prefixBefore), 'Temporary completed-prefix source changed during verification');
      const current = await preconditions();
      requireValue(equal(pre, current), 'Source, branch, checkpoint evidence or task state changed during reconciliation');
    };
    await unchanged(); monitor = monitorTrackedInputs(repository);
    if (options.interruptedTask) {
      prefixRoot = await mkdtemp(path.join(tmpdir(), 'pi-interrupted-prefix-'));
      prefixDirectory = path.join(prefixRoot, 'worktree');
      git(repository, ['-c', 'core.hooksPath=' + prefixRoot, 'worktree', 'add', '--detach', prefixDirectory, args.headRef]);
      prefixBefore = await snapshot(prefixDirectory);
      requireValue(prefixBefore.clean && !prefixBefore.bookkeepingVisible && prefixBefore.head === args.headRef,
        'Temporary completed-prefix worktree is not clean');
      prefixMonitor = monitorTrackedInputs(prefixDirectory);
    }
    const verifiedBefore = prefixBefore ?? pre.before;
    const binding = { feature_id: args.featureId, design_ref: args.designRef, baseline: args.upstreamBaseRef,
      head: args.headRef, tree: verifiedBefore.tree, branch: args.branch, task_revision: pre.feature.task_revision ?? 0,
      plan_digest: digest(JSON.stringify(plan)) };
    record = { kind: 'reconciliation', originalBaseline: args.featureBaseRef, oldHead: args.oldHeadRef,
      previousReconciliationRef: args.previousReconciliationRef, binding, plan, feature: pre.feature, tasks: pre.feature.tasks,
      sourceCheckpoints: pre.source, checkpoints: pre.checkpoints, requirements, before: verifiedBefore, after: verifiedBefore,
      ...(options.interruptedTask ? { interruptedTask: options.interruptedTask.taskId, interruptedSource: pre.before } : {}),
      checks: [], review: null, result: result('BLOCKED', 'INTERRUPTED_OR_RUNNING') };
    startedReference = await retainReconciliation(repository, record);
    await options.interrupt?.('beforeChecks');
    for (const check of plan.checks) {
      const output = await runCheck(check.command, { cwd: prefixDirectory ?? repository, signal: context.abort, timeoutMs: plan.timeoutMs });
      record.checks.push({ name: check.name, definition: check, ...output, meaningful: meaningful(check, output) });
      await unchanged();
      if (output.problem || output.exit_code === null) { record.result = result('BLOCKED', 'Check indeterminate: ' + (output.problem ?? check.name)); break; }
      if (output.exit_code !== 0) { record.result = result('NEEDS_DESIGN', 'Rebased project check failed: ' + check.name); break; }
      if (!record.checks.at(-1).meaningful) { record.result = result('BLOCKED', 'Meaningful coverage not established: ' + check.name); break; }
    }
    if (record.checks.length === plan.checks.length && record.checks.every(c => c.meaningful)) {
      await options.interrupt?.('beforeReview');
      record.review = await reviewChanges({ ...plan.review, repository: prefixDirectory ?? repository, baseRef: binding.baseline, headRef: binding.head,
        requirements: reviewScope(requirements, record.checks) }, context, options.reviewOptions);
      record.review.requirementsDigest = digest(reviewScope(requirements, record.checks));
      await unchanged();
      record.result = result(record.review.status === 'APPROVED' ? 'PASSED' : record.review.status === 'CHANGES_REQUESTED' ? 'NEEDS_DESIGN' : 'BLOCKED',
        record.review.reason ?? record.review.message ?? 'Independent review indeterminate');
    }
    await unchanged();
    await options.interrupt?.('beforeRetention');
    evidenceRef = await retainReconciliation(repository, record);
    await options.interrupt?.('afterRetention');
    await unchanged();
    return { ...record.result, evidenceRef, startedReference, binding, ...(record.result.status === 'PASSED' ? { nextBaseRef: args.headRef } : {}), checks: record.checks, review: record.review };
  } catch (error) {
    let diagnosticEvidenceRef;
    if (record && repository) {
      try { diagnosticEvidenceRef = await retainReconciliation(repository, { ...record, result: result('BLOCKED', error.message), after: await snapshot(repository) }); } catch {}
    }
    return { ...result('BLOCKED', error.message), evidenceRef, startedReference, diagnosticEvidenceRef,
      recovery: 'Inspect retained evidence, original checkpoints, actual Git and Scaffold state; never rewrite old receipts or reset work' };
  } finally {
    monitor?.close(); prefixMonitor?.close();
    if (prefixDirectory) {
      // Only this operation's disposable worktree is removed; never the source checkout.
      try { git(repository, ['worktree', 'remove', '--force', prefixDirectory]); } catch { /* Leave registered scratch state discoverable if Git cleanup fails. */ }
    }
    if (prefixRoot) await rm(prefixRoot, { recursive: true, force: true }).catch(() => {});
  }
}

export async function inspectReconciliation(args, context = {}, options = {}) {
  try {
    const repository = path.resolve(git(context.directory, ['rev-parse', '--show-toplevel']));
    const refs = args.reference ? [args.reference] : await featureEvidenceReferences(repository);
    const results = [];
    for (const reference of refs) {
      const record = await readFeatureEvidence(repository, reference);
      if (record.kind !== 'reconciliation' || (args.featureId && record.binding.feature_id !== args.featureId)) continue;
      let applicable = false, reason;
      try {
        const feature = await state(repository, record.binding.feature_id, options);
        const anchor = await readReconciliation(repository, reference, feature,
          { branch: record.binding.branch, featureBaseRef: record.originalBaseline });
        await assertNoGitOperation(repository);
        const current = await snapshot(repository);
        requireValue(current.clean && !current.bookkeepingVisible && git(repository, ['symbolic-ref', '--quiet', '--short', 'HEAD']) === record.binding.branch,
          'Current branch/worktree is not eligible');
        await checkpointHistory(repository, feature, { head: current.head, baseline: record.originalBaseline, branch: record.binding.branch, anchor });
        applicable = true;
      } catch (error) { reason = error.message; }
      results.push({ reference, record, applicable, ...(reason ? { reason } : {}) });
    }
    return { ok: true, results };
  } catch (error) { return { ok: false, message: error.message }; }
}

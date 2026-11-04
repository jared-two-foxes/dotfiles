// Verification-only final feature gate. Pi retains selection, design and correction decisions.
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual as equal } from 'node:util';
import { git, assertNoGitOperation } from './git-tree.mjs';
import { reviewEvidence } from './review-evidence.mjs';
import { digest, snapshot, readEvidence, retainFeatureEvidence, readFeatureEvidence, featureEvidenceReferences } from './evidence.mjs';
import { checkpointHistory } from './history.mjs';
import { readReconciliation } from './reconciliation.mjs';
import { scaffoldTasks, invoke, checkStatePaths } from '../scaffold/adapter.mjs';
import { reviewChanges } from '../review/adapter.mjs';
import { planFor, meaningful, monitorTrackedInputs, approvedDesign, featureRequirements, reviewScope, authenticateFeatureRecord, featureObligationsVerified } from './feature-verification.mjs';
import { runCheck } from './feature-process.mjs';
import { obligationsVerified, findingObligations } from './delivery-context.mjs';
import { authenticateAmendment } from './context-amendment.mjs';

const requireValue = (ok, message) => { if (!ok) throw new Error(message); };
const result = (status, fields = {}) => ({ schema: 'pi.feature-validation/v1', status, ...fields });
const stable = (a, b) => a.head === b.head && a.tree === b.tree && a.digest === b.digest && b.clean && !b.bookkeepingVisible;

async function state(repository, featureId, options) {
  const response = await scaffoldTasks({ operation: 'list', feature_id: featureId }, { directory: repository }, options.scaffoldOptions);
  requireValue(response.ok, 'Cannot inspect Scaffold: ' + (response.message ?? 'invalid response'));
  return response.data.feature;
}
async function lifecycle(repository, operation, featureId, payload, options) {
  await checkStatePaths(repository);
  const response = await (options.scaffoldOptions?.invokeScaffold ?? invoke)('scaffold',
    ['tasks', operation, '--feature=' + featureId, '--input', '-'], { cwd: repository, input: JSON.stringify(payload) });
  requireValue(response.code === 0, 'Scaffold validation transition failed: ' + response.stderr?.slice(0, 4000));
  const data = JSON.parse(response.stdout);
  requireValue(data.schema_version === 2 && data.feature?.id === featureId && data.feature.validation,
    'Unsupported Scaffold validation response; install Phase 5 Scaffold');
  return data.feature;
}

export async function featurePreconditions(repository, args, options = {}) {
  await assertNoGitOperation(repository);
  requireValue(git(repository, ['symbolic-ref', '--quiet', '--short', 'HEAD']) === args.branch, 'Feature branch changed or detached');
  const before = await snapshot(repository);
  requireValue(before.clean && !before.bookkeepingVisible && before.head === args.headRef &&
    before.tree === git(repository, ['rev-parse', args.headRef + '^{tree}']), 'Validation requires clean matching HEAD/index/worktree and ignored Scaffold');
  const feature = await state(repository, args.featureId, options);
  requireValue(feature.design_ref === args.designRef, 'Approved design identity mismatch');
  const design = approvedDesign(repository, feature);
  requireValue(!feature.original_baseline || feature.original_baseline === args.featureBaseRef, 'Original feature baseline mismatch');
  requireValue(feature.workflow.phase === 'implement', 'Finish issue graph design before feature validation');
  const tasks = feature.tasks;
  for (const task of Object.values(tasks)) for (const a of task.delivery?.context?.amendments ?? [])
    requireValue(equal(await authenticateAmendment(repository, a.reference,
      { featureId: feature.id, taskId: task.id, designRef: feature.design_ref }), a), 'Invalid persisted feature amendment');
  const identifiers = Object.keys(tasks);
  requireValue(identifiers.length > 0 && identifiers.every(id => tasks[id].status === 'completed'),
    'All required tasks, including recursive parents, must be completed');
  const anchor = args.reconciliationRef
    ? await readReconciliation(repository, args.reconciliationRef, feature, args) : undefined;
  const checkpoints = await checkpointHistory(repository, feature, {
    head: args.headRef, baseline: args.featureBaseRef, branch: args.branch, anchor });
  // Preserve the Scaffold journal as recorded. Only close a historical check in
  // the review view when the authenticated checkpoint assessed its passing retry.
  const reviewTasks = structuredClone(tasks);
  for (const checkpoint of checkpoints) {
    const task = reviewTasks[checkpoint.taskId];
    if (!task.delivery?.context?.obligations?.some(o => o.id.startsWith('check-') && o.status === 'open')) continue;
    const receipt = await readEvidence(repository, checkpoint.evidenceRef);
    if (receipt.producer !== 'pi.command-receipts/v2') continue;
    const { runner, review } = receipt.result.conductor;
    const resolved = new Set(reviewEvidence(receipt, runner, receipt.reviewSnapshot).checks
      .flatMap(check => check.resolvesCheckObligations));
    for (const obligation of task.delivery.context.obligations)
      if (resolved.has(obligation.id) && review.obligation_assessments?.some(a =>
        a.obligation_id === obligation.id && a.disposition === 'verified'))
        obligation.status = 'independently_verified';
  }
  const reviews = [];
  const resumedId = args.resumeEvidenceRef ? (await readFeatureEvidence(repository, args.resumeEvidenceRef)).attemptId : null;
  for (const reference of await featureEvidenceReferences(repository)) {
    const r = await readFeatureEvidence(repository, reference);
    if (r.attemptId !== resumedId && r.binding?.feature_id === args.featureId && r.result?.schema === 'pi.feature-validation/v1' && r.review)
      reviews.push(r);
  }
  const obligations = findingObligations(reviews.sort((a, b) => String(a.recordedAt).localeCompare(String(b.recordedAt)))
    .map(r => ({ result: { conductor: { review: r.review } } })));
  return { feature, before, checkpoints, design, anchor, obligations, reviewTasks };
}

function handoff(record, reference) {
  return { ...record.result, attempt_id: record.attemptId, binding: record.binding, reference,
    checks: record.checks, review: record.review ?? null, message: record.result.message ?? '' };
}
function assembledRequirements(pre, args, versioned = true, scopedChecks = true) {
  const feature = scopedChecks ? { ...pre.feature, tasks: pre.reviewTasks } : pre.feature;
  return featureRequirements(feature, pre.design) + (versioned ?
    '\n\nPersisted feature obligations: ' + JSON.stringify(pre.obligations) +
    '\nExplicitly assess every open ID using obligation_assessments with disposition verified and concrete evidence; agent claims do not close findings.' : '') +
    (args.reconciliationRef ? '\n\nVerified rebase reconciliation: ' + args.reconciliationRef +
      '\nNew upstream baseline: ' + pre.anchor.baseline : '');
}
export async function validateFeature(args, context = {}, options = {}) {
  let repository, startedReference, reference, record, monitor, started = false;
  try {
    context.abort?.throwIfAborted();
    const plan = planFor(args);
    repository = path.resolve(git(context.directory, ['rev-parse', '--show-toplevel']));
    const pre = await featurePreconditions(repository, args, options);
    const binding = { feature_id: args.featureId, design_ref: args.designRef, baseline: args.featureBaseRef,
      head: args.headRef, tree: pre.before.tree, branch: args.branch, task_revision: pre.feature.task_revision ?? 0,
      plan_digest: digest(JSON.stringify(plan)) };
    const requirements = assembledRequirements(pre, args);
    const reviewTasks = pre.reviewTasks;
    if (args.resumeEvidenceRef) {
      record = await readFeatureEvidence(repository, args.resumeEvidenceRef);
      const scopedChecks = record.scopedTaskChecks === true;
      const expectedRequirements = assembledRequirements(pre, args, record.obligations !== undefined, scopedChecks);
      requireValue(record.requirements === expectedRequirements && (record.reconciliationRef ?? null) === (args.reconciliationRef ?? null), 'Approved feature requirements or reconciliation changed');
      authenticateFeatureRecord(record, binding, plan, pre.feature.tasks, expectedRequirements, undefined,
        scopedChecks ? reviewTasks : pre.feature.tasks);
      // Idempotent Scaffold recording handles loss of the original confirmation.
      const current = pre.feature.validation;
      requireValue(current?.current === record.attemptId, 'Result is superseded; run a new validation');
      await lifecycle(repository, 'validation-record', args.featureId, handoff(record, args.resumeEvidenceRef), options);
      const post = await featurePreconditions(repository, args, options);
      requireValue(stable(pre.before, post.before) && equal(pre.feature.tasks, post.feature.tasks), 'Source/state changed during recovery');
      return { ...record.result, evidenceRef: args.resumeEvidenceRef, binding, recovered: true, checks: record.checks, review: record.review };
    }
    requireValue(await options.authorize?.({ repository, binding, plan }), 'Explicit feature verification authorization required');
    context.abort?.throwIfAborted();
    const confirmed = await featurePreconditions(repository, args, options);
    requireValue(equal(confirmed.feature.tasks, pre.feature.tasks) && stable(pre.before, confirmed.before), 'Source/state changed during authorization');
    monitor = monitorTrackedInputs(repository);
    record = { attemptId: randomUUID(), binding, plan, reconciliationRef: args.reconciliationRef, tasks: pre.feature.tasks, requirements,
      obligations: pre.obligations, scopedTaskChecks: true,
      before: pre.before, after: pre.before, checkpoints: pre.checkpoints, checks: [], review: null,
      result: result('BLOCKED', { message: 'INTERRUPTED_OR_RUNNING' }) };
    startedReference = await retainFeatureEvidence(repository, record);
    await lifecycle(repository, 'validation-start', args.featureId, { attempt_id: record.attemptId, binding }, options);
    started = true;
    await options.interrupt?.('beforeChecks');
    const unchanged = async () => {
      monitor.assert();
      context.abort?.throwIfAborted();
      const current = await featurePreconditions(repository, args, options);
      requireValue(stable(pre.before, current.before) && equal(pre.feature.tasks, current.feature.tasks) &&
        current.feature.validation?.current === record.attemptId, 'Source, task graph or active validation changed; reconcile');
      record.after = current.before;
    };
    for (const check of plan.checks) {
      const output = await runCheck(check.command, { cwd: repository, signal: context.abort, timeoutMs: plan.timeoutMs });
      record.checks.push({ name: check.name, definition: check, ...output, meaningful: meaningful(check, output) });
      await unchanged();
      if (output.problem || output.exit_code === null) {
        record.result = result('BLOCKED', { message: 'Check indeterminate: ' + (output.problem ?? check.name) }); break;
      }
      if (output.exit_code !== 0) { record.result = result('NEEDS_DESIGN', { message: 'Project check failed: ' + check.name }); break; }
      if (!record.checks.at(-1).meaningful) { record.result = result('BLOCKED', { message: 'Meaningful coverage not established: ' + check.name }); break; }
    }
    if (record.checks.length === plan.checks.length && record.checks.every(c => c.meaningful)) {
      await options.interrupt?.('beforeReview');
      const review = await reviewChanges({ ...plan.review, repository, baseRef: binding.baseline, headRef: binding.head,
        requirements: reviewScope(requirements, record.checks) }, context, options.reviewOptions);
      record.review = { ...review, requirementsDigest: digest(reviewScope(requirements, record.checks)) };
      await unchanged();
      record.result = result(review.status === 'APPROVED' && featureObligationsVerified(reviewTasks, review) &&
        obligationsVerified({ deliveryContext: { obligations: pre.obligations } }, review) ? 'PASSED' : review.status === 'CHANGES_REQUESTED' ? 'NEEDS_DESIGN' : 'BLOCKED',
        { message: review.reason ?? review.message ?? 'Independent review indeterminate' });
    }
    await unchanged();
    await options.interrupt?.('beforeRetention');
    reference = await retainFeatureEvidence(repository, record);
    await options.interrupt?.('afterRetention');
    await unchanged();
    await lifecycle(repository, 'validation-record', args.featureId, handoff(record, reference), options);
    await options.interrupt?.('afterCompletion');
    await unchanged();
    return { ...record.result, binding, evidenceRef: reference, startedReference, checks: record.checks, review: record.review };
  } catch (error) {
    const blocked = result('BLOCKED', { message: error.message, ...(reference ? { evidenceRef: reference } : {}),
      ...(startedReference ? { startedReference } : {}), recovery: 'Inspect Scaffold, actual Git state and retained feature evidence; never infer success from interruption' });
    if (repository && started) {
      // Preserve diagnostics without overwriting a retained PASSED receipt needed for recovery.
      try {
        const failed = { ...record, result: result('BLOCKED', { message: error.message }),
          after: await snapshot(repository) };
        const failureRef = await retainFeatureEvidence(repository, failed);
        blocked.diagnosticEvidenceRef = failureRef;
        // A post-retention interruption may have succeeded; leave that intent recoverable.
        if (!reference) await lifecycle(repository, 'validation-record', args.featureId, handoff(failed, failureRef), options);
        else if (!(await snapshot(repository)).clean || git(repository, ['rev-parse', 'HEAD']) !== record.binding.head)
          await lifecycle(repository, 'validation-invalidate', args.featureId, { reason: error.message }, options);
      } catch { /* The retained intent remains authoritative as interrupted, never successful. */ }
    }
    return blocked;
  } finally { monitor?.close(); }
}

export async function inspectFeatureValidation(args, context = {}, options = {}) {
  try {
    const repository = path.resolve(git(context.directory, ['rev-parse', '--show-toplevel']));
    const refs = args.reference ? [args.reference] : await featureEvidenceReferences(repository);
    const results = [];
    for (const reference of refs) {
      const record = await readFeatureEvidence(repository, reference);
      if (['reconciliation', 'feature-authorization', 'delivery-amendment'].includes(record.kind) || (args.featureId && record.binding?.feature_id !== args.featureId)) continue;
      let applicable = false, reason;
      try {
        const b = record.binding;
        const args = { featureId: b.feature_id, designRef: b.design_ref, branch: b.branch, featureBaseRef: b.baseline, headRef: b.head, reconciliationRef: record.reconciliationRef, resumeEvidenceRef: reference };
        const pre = await featurePreconditions(repository, args, options);
        requireValue(pre.feature.validation?.current === record.attemptId, 'Validation superseded');
        authenticateFeatureRecord(record, { ...b, task_revision: pre.feature.task_revision ?? 0 }, record.plan,
          pre.feature.tasks, assembledRequirements(pre, args, record.obligations !== undefined, record.scopedTaskChecks === true),
          undefined, record.scopedTaskChecks === true ? pre.reviewTasks : pre.feature.tasks);
        applicable = true;
      } catch (error) { reason = error.message; }
      results.push({ reference, record, applicable, ...(reason ? { reason } : {}) });
    }
    return { ok: true, results };
  } catch (error) { return { ok: false, message: error.message }; }
}

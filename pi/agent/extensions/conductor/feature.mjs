// Verification-only final feature gate. Pi retains selection, design and correction decisions.
import path from 'node:path';
import { watch } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual as equal } from 'node:util';
import { git, assertNoGitOperation } from './git-tree.mjs';
import { digest, snapshot, retainFeatureEvidence, readFeatureEvidence, featureEvidenceReferences } from './evidence.mjs';
import { authenticateTaskEvidence } from './checkpoint.mjs';
import { scaffoldTasks, designReference, invoke, checkStatePaths } from '../scaffold/adapter.mjs';
import { reviewChanges, validateReviewResult, reviewSettings } from '../review/adapter.mjs';
import { runCheck } from './feature-process.mjs';

const requireValue = (ok, message) => { if (!ok) throw new Error(message); };
const sha = x => typeof x === 'string' && /^[a-f0-9]{40}$/.test(x);
const result = (status, fields = {}) => ({ schema: 'pi.feature-validation/v1', status, ...fields });
const stable = (a, b) => a.head === b.head && a.tree === b.tree && a.digest === b.digest && b.clean && !b.bookkeepingVisible;

function planFor(args) {
  requireValue(args && ['featureId', 'designRef', 'branch'].every(k => typeof args[k] === 'string' && args[k].trim()), 'Feature/design/branch required');
  requireValue(sha(args.featureBaseRef) && sha(args.headRef), 'Original feature baseline and current HEAD must be full SHAs');
  const checks = [
    { name: 'build', command: args.buildCommand },
    { name: 'test', command: args.testCommand, successPattern: args.testSuccessPattern },
    ...(args.integrationChecks ?? []),
  ];
  requireValue(checks.length <= 16 && new Set(checks.map(c => c.name)).size === checks.length, 'At most 16 uniquely named checks');
  for (const c of checks) {
    requireValue(typeof c.name === 'string' && c.name.trim() && Array.isArray(c.command) && c.command.length > 0 && c.command.length <= 64 &&
      c.command.every(x => typeof x === 'string' && x.length > 0 && x.length <= 8192 && !x.includes('\0')), 'Checks require executable/argument arrays');
    if (c.name !== 'build') {
      requireValue(typeof c.successPattern === 'string' && c.successPattern.length > 0 && c.successPattern.length <= 512,
        'Test and integration checks require approved successPattern describing meaningful exercised behavior');
      // Literal output markers avoid regex execution and ambiguous empty matches.
    }
  }
  const timeoutMs = args.checkTimeoutMs ?? 300000;
  requireValue(Number.isInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 900000, 'Check timeout must be 1..900000 ms');
  requireValue(args.review === undefined || (args.review !== null && typeof args.review === 'object' && !Array.isArray(args.review)), 'Invalid review settings');
  requireValue(args.integrationChecks === undefined || Array.isArray(args.integrationChecks), 'Integration checks must be an array');
  const review = { model: process.env.REVIEW_MODEL ?? 'opencode/gpt-6.1-sol', wallClockBudgetSecs: 180, maxTurns: 20, ...(args.review ?? {}) };
  requireValue(review && typeof review === 'object' && !Array.isArray(review) && Object.keys(review).every(k =>
    ['model', 'wallClockBudgetSecs', 'maxTurns', 'maxCostUsd', 'maxToolCalls', 'maxRepeatedActions', 'maxCompletionAttempts'].includes(k)), 'Invalid review settings');
  const normalized = reviewSettings(review); // Reuse Review validation before project commands.
  return { checks, timeoutMs, review: { ...review, model: normalized.model,
    wallClockBudgetSecs: normalized.budget, maxTurns: normalized.turns } };
}
function meaningful(check, output) {
  const text = output.stdout + '\n' + output.stderr;
  return output.exit_code === 0 && !output.problem && (check.name === 'build' ||
    (text.includes(check.successPattern) && !/\b(?:0 tests|no tests (?:found|ran|collected)|0 passed)\b/i.test(text)));
}
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
  requireValue(data.schema_version === 1 && data.feature?.id === featureId && data.feature.validation,
    'Unsupported Scaffold validation response; install Phase 5 Scaffold');
  return data.feature;
}

function monitorTrackedInputs(repository) {
  const files = git(repository, ['ls-files', '-z']).split('\0').filter(Boolean);
  const watchers = [];
  let changed = false;
  try {
    const tracked = new Set(files.map(f => path.resolve(repository, f)));
    for (const dir of new Set(files.map(f => path.dirname(path.resolve(repository, f))))) {
      const watcher = watch(dir, (_event, name) => {
        if (!name || tracked.has(path.resolve(dir, name.toString()))) changed = true;
      });
      watcher.on('error', () => { changed = true; }); watchers.push(watcher);
    }
  } catch (error) { watchers.forEach(w => w.close()); throw error; }
  return { assert: () => requireValue(!changed, 'Tracked implementation inputs changed during validation; reconcile'),
    close: () => watchers.forEach(w => w.close()) };
}
function approvedDesign(repository, feature) {
  if (feature.design_ref === designReference(feature.context)) return feature.context;
  // Legacy Git references must resolve immutable original text, never a reconstructed task summary.
  const match = /^(.+)@([a-f0-9]{40})$/.exec(feature.design_ref ?? '');
  requireValue(match && !match[1].includes('\0'), 'Recover complete original approved design: sha256 context or path@full-commit-SHA');
  const design = git(repository, ['show', match[2] + ':' + match[1]]);
  requireValue(design.trim().length > 0, 'Original approved design is empty');
  return design;
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
  const tasks = feature.tasks;
  const identifiers = Object.keys(tasks);
  requireValue(identifiers.length > 0 && identifiers.every(id => tasks[id].status === 'completed'),
    'All required tasks, including recursive parents, must be completed');
  const checkpoints = [], seen = new Set();
  let cursor = args.headRef;
  while (cursor !== args.featureBaseRef) {
    requireValue(checkpoints.length < identifiers.length, 'Unrelated or duplicate commits in checkpoint history');
    const parents = git(repository, ['show', '-s', '--format=%P', cursor]).split(' ');
    requireValue(parents.length === 1 && sha(parents[0]), 'Checkpoint must have exactly one parent');
    const lines = git(repository, ['show', '-s', '--format=%B', cursor]).split('\n').filter(l => l.startsWith('Pi-Task-Checkpoint: '));
    requireValue(lines.length === 1, 'Missing/ambiguous checkpoint provenance');
    const p = JSON.parse(lines[0].slice('Pi-Task-Checkpoint: '.length));
    requireValue(p.schema === 'pi.task-checkpoint/v1' && p.featureId === args.featureId && p.designRef === args.designRef &&
      p.branch === args.branch && p.featureBaseRef === args.featureBaseRef && p.baseRef === parents[0] &&
      p.tree === git(repository, ['rev-parse', cursor + '^{tree}']) && tasks[p.taskId] && !seen.has(p.taskId),
    'Checkpoint lineage, identity or Git tree mismatch');
    const task = tasks[p.taskId], completion = task.history.at(-1);
    requireValue(completion?.to === 'completed' && completion.evidence?.reference === p.evidenceRef &&
      completion.evidence?.source === 'conductor' && completion.evidence?.result === 'PASSED' &&
      completion.evidence?.feature_id === args.featureId && completion.evidence?.task_id === p.taskId,
    'Checkpoint does not match Scaffold completion');
    const evidence = await authenticateTaskEvidence(repository, p.evidenceRef,
      { featureId: p.featureId, taskId: p.taskId, designRef: p.designRef });
    requireValue(evidence.args.baseRef === p.baseRef && evidence.after.tree === p.tree, 'Receipt and checkpoint disagree');
    checkpoints.unshift({ commit: cursor, ...p }); seen.add(p.taskId); cursor = parents[0];
  }
  requireValue(seen.size === identifiers.length, 'Every task requires an authentic checkpoint, including empty parents');
  const completed = new Set();
  for (const p of checkpoints) {
    const task = tasks[p.taskId];
    const dependencies = new Set(task.dependencies);
    let parent = task.parent_id;
    const ancestors = new Set();
    while (parent !== null) {
      requireValue(tasks[parent] && !ancestors.has(parent), 'Invalid recursive task ancestry');
      ancestors.add(parent); tasks[parent].dependencies.forEach(d => dependencies.add(d)); parent = tasks[parent].parent_id;
    }
    Object.values(tasks).filter(t => t.parent_id === task.id).forEach(t => dependencies.add(t.id));
    requireValue([...dependencies].every(d => completed.has(d)), 'Checkpoint ordering violates task prerequisites');
    completed.add(p.taskId);
  }
  return { feature, before, checkpoints, design };
}

function featureRequirements(feature, design) {
  return design + '\n\nOriginal feature acceptance criteria:\n' +
      feature.acceptance_criteria.map(c => '- ' + c).join('\n') + '\n\nConstraints:\n' +
      (feature.constraints ?? []).join('\n') +
      '\n\nIndependently assess the COMPLETE feature, cross-task integration, interfaces, data structures, invariants, architecture, regressions, missing behavior, errors and edge cases. Inspect check diagnostics for meaningful coverage; zero exits alone are insufficient. Never weaken the original acceptance criteria.';
}
const reviewScope = (requirements, checks) => requirements +
  '\n\nActual full-project verification diagnostics:\n' + JSON.stringify(checks);

function handoff(record, reference) {
  return { ...record.result, attempt_id: record.attemptId, binding: record.binding, reference,
    checks: record.checks, review: record.review ?? null, message: record.result.message ?? '' };
}
function authenticateFeatureRecord(record, binding, plan, tasks, requirements) {
  requireValue(record.result?.schema === 'pi.feature-validation/v1' && record.result.status === 'PASSED' &&
    equal(record.binding, binding) && binding.plan_digest === digest(JSON.stringify(plan)) &&
    record.requirements === requirements && equal(record.plan, plan) && equal(record.tasks, tasks) &&
    stable(record.before, record.after) && record.before.head === binding.head && record.after.tree === binding.tree &&
    record.checks?.length === plan.checks.length && record.checks.every((c, i) =>
      equal(c.definition, plan.checks[i]) && meaningful(c.definition, c) && c.meaningful === true),
  'Retained result is interrupted, stale or incomplete');
  validateReviewResult(record.review, 0);
  requireValue(record.review.status === 'APPROVED' && record.review.baseRef === binding.baseline &&
    record.review.headRef === binding.head && record.review.model === plan.review.model &&
    record.review.requirementsDigest === digest(reviewScope(record.requirements, record.checks)),
  'Retained review is incomplete or mismatched');
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
    const requirements = featureRequirements(pre.feature, pre.design);
    if (args.resumeEvidenceRef) {
      record = await readFeatureEvidence(repository, args.resumeEvidenceRef);
      requireValue(record.requirements === requirements, 'Approved feature requirements changed');
      authenticateFeatureRecord(record, binding, plan, pre.feature.tasks, requirements);
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
    record = { attemptId: randomUUID(), binding, plan, tasks: pre.feature.tasks, requirements,
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
      record.result = result(review.status === 'APPROVED' ? 'PASSED' : review.status === 'CHANGES_REQUESTED' ? 'NEEDS_DESIGN' : 'BLOCKED',
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
      if (args.featureId && record.binding?.feature_id !== args.featureId) continue;
      let applicable = false, reason;
      try {
        const b = record.binding;
        const args = { featureId: b.feature_id, designRef: b.design_ref, branch: b.branch, featureBaseRef: b.baseline, headRef: b.head };
        const pre = await featurePreconditions(repository, args, options);
        requireValue(pre.feature.validation?.current === record.attemptId, 'Validation superseded');
        authenticateFeatureRecord(record, { ...b, task_revision: pre.feature.task_revision ?? 0 }, record.plan, pre.feature.tasks, featureRequirements(pre.feature, pre.design));
        applicable = true;
      } catch (error) { reason = error.message; }
      results.push({ reference, record, applicable, ...(reason ? { reason } : {}) });
    }
    return { ok: true, results };
  } catch (error) { return { ok: false, message: error.message }; }
}

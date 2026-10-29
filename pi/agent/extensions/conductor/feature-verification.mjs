// Shared bounded verification contracts for final validation and rebase recovery.
import { watch } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual as equal } from 'node:util';
import { git } from './git-tree.mjs';
import { digest } from './evidence.mjs';
import { designReference } from '../scaffold/adapter.mjs';
import { validateReviewResult, reviewSettings } from '../review/adapter.mjs';
const requireValue = (ok, message) => { if (!ok) throw new Error(message); };
const sha = x => typeof x === 'string' && /^[a-f0-9]{40}$/.test(x);
const stable = (a, b) => a.head === b.head && a.tree === b.tree && a.digest === b.digest && b.clean && !b.bookkeepingVisible;

export function planFor(args) {
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
export function meaningful(check, output) {
  if (output.exit_code !== 0 || output.problem) return false;
  if (check.name === 'build') return true;
  const text = output.stdout + '\n' + output.stderr;
  if (!text.includes(check.successPattern)) return false;
  // A workspace may contain substantive suites AND empty harnesses/doc-tests.
  // An empty-run diagnostic only vetoes coverage when no completed positive
  // test count is reported. Merely scheduling/running N tests is not enough.
  // Counts and labels must share a physical line (and output stream).
  const emptyRun = /\b(?:0[ \t]+(?:tests?|passed|passing)|no tests (?:found|ran|collected))\b|\b(?:pass|passed)[ \t]*[:=]?[ \t]*0\b/i;
  const positivePasses = /\b[1-9]\d*[ \t]+(?:passed|passing|tests?[ \t]+passed)\b|\b(?:pass|passed)[ \t]*[:=]?[ \t]*[1-9]\d*\b/i;
  return !emptyRun.test(text) || positivePasses.test(text);
}

export function monitorTrackedInputs(repository) {
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
export function approvedDesign(repository, feature) {
  if (feature.design_ref === designReference(feature.context)) return feature.context;
  // Legacy Git references must resolve immutable original text, never a reconstructed task summary.
  const match = /^(.+)@([a-f0-9]{40})$/.exec(feature.design_ref ?? '');
  requireValue(match && !match[1].includes('\0'), 'Recover complete original approved design: sha256 context or path@full-commit-SHA');
  const design = git(repository, ['show', match[2] + ':' + match[1]]);
  requireValue(design.trim().length > 0, 'Original approved design is empty');
  return design;
}


export function featureRequirements(feature, design) {
  return design + '\n\nOriginal feature acceptance criteria:\n' +
      feature.acceptance_criteria.map(c => '- ' + c).join('\n') + '\n\nConstraints:\n' +
      (feature.constraints ?? []).join('\n') +
      (feature.workflow?.kind === 'recursive-issues/v1' ? '\n\nApproved issue designs and contracts:\n' + JSON.stringify(Object.values(feature.tasks).map(t => ({ id: t.id, parent: t.parent_id, origin: t.origin, criteria: t.acceptance_criteria, constraints: t.constraints, designs: t.designs, earlierDesigns: t.design_history }))) : '') +
      '\n\nIndependently assess the COMPLETE feature, cross-task integration, interfaces, data structures, invariants, architecture, regressions, missing behavior, errors and edge cases. Inspect check diagnostics for meaningful coverage; zero exits alone are insufficient. Never weaken the original acceptance criteria.';
}
export const reviewScope = (requirements, checks) => requirements +
  '\n\nActual full-project verification diagnostics:\n' + JSON.stringify(checks);


export function authenticateFeatureRecord(record, binding, plan, tasks, requirements, schema = 'pi.feature-validation/v1') {
  requireValue(record.result?.schema === schema && record.result.status === 'PASSED' &&
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


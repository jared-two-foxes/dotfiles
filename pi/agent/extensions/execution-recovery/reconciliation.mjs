// Native recovery after the user rebased the feature branch BETWEEN tasks. Verification-only: it
// never rebases, edits Git or changes task status. It maps the ledger's recorded history onto the
// rebased commits, runs fresh full-project checks and an independent review of the result, and
// only then records a `history-rewrite` entry. The previous history stays in the ledger (epochs).
import path from 'node:path';
import { isDeepStrictEqual as equal } from 'node:util';
import { git, assertNoGitOperation } from '../../lib/git/tree.mjs';
import { snapshot } from '../../lib/git/snapshot.mjs';
import { digest, retainFeatureEvidence, readFeatureEvidence } from '../../lib/evidence/store.mjs';
import { scaffoldFeatureOrNull, scaffoldTasks } from '../scaffold/adapter.mjs';
import { planFor, meaningful, approvedDesign, featureRequirements, reviewScope } from '../../lib/verification/feature.mjs';
import { foreignHistoryRequirements, verifyHistory } from '../../lib/verification/history.mjs';
import { planRewrite } from '../../lib/verification/rewrite-history.mjs';
import { approved } from '../../lib/authorization/feature.mjs';
import { monitorTrackedInputs } from '../../lib/git/monitor.mjs';
import { reviewChanges } from '../../lib/review/adapter.mjs';
import { runCheck } from '../feature-validation/check-process.mjs';

const requireValue = (ok, message) => { if (!ok) throw new Error(message); };
const sha = x => /^[a-f0-9]{40}$/.test(x ?? '');
const result = (status, message) => ({ schema: 'pi.history-rewrite/v1', status, message });

async function readFeature(repository, featureId, options) {
  const feature = await scaffoldFeatureOrNull(repository, featureId, options.scaffoldOptions);
  requireValue(feature, 'Unknown feature: ' + featureId);
  return feature;
}
const record = async (repository, featureId, payload, options) => {
  const response = await scaffoldTasks({ operation: 'history-rewrite', feature_id: featureId, payload }, { directory: repository }, options.scaffoldOptions);
  requireValue(response.ok, 'Scaffold refused the rewrite: ' + response.message + (response.stderr ? ' ' + response.stderr : ''));
};

export async function rewriteFeatureHistory(args, context = {}, options = {}) {
  let repository, monitor, verification, reference;
  try {
    context.abort?.throwIfAborted();
    requireValue(sha(args.oldHeadRef) && sha(args.upstreamBaseRef) && sha(args.headRef), 'The recorded head, the new base and HEAD must be full SHAs');
    const plan = planFor({ ...args, featureBaseRef: args.upstreamBaseRef });
    repository = path.resolve(git(context.directory, ['rev-parse', '--show-toplevel']));

    const preconditions = async () => {
      await assertNoGitOperation(repository);
      const branch = git(repository, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
      requireValue(branch === args.branch && !['main', 'master', args.defaultBranch, ...(args.protectedBranches ?? [])].includes(branch),
        'Feature branch changed or protected');
      requireValue(typeof args.defaultBranch === 'string' && args.defaultBranch.trim() && Array.isArray(args.protectedBranches) &&
        args.protectedBranches.every(b => typeof b === 'string'), 'Known default and protected branches required');
      let remoteDefault;
      try { remoteDefault = git(repository, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']).replace(/^origin\//, ''); } catch {}
      requireValue(branch !== remoteDefault, 'Default branch rewrite prohibited');
      const before = await snapshot(repository);
      requireValue(before.clean && !before.bookkeepingVisible && before.head === args.headRef,
        'Rewrite requires a clean matching HEAD/index/worktree and ignored Scaffold state');
      const feature = await readFeature(repository, args.featureId, options);
      requireValue(feature.design_ref === args.designRef, 'Approved design identity mismatch');
      requireValue(approved(feature), 'Approve the feature direction before rewriting history');
      requireValue(feature.head === args.oldHeadRef, 'Recorded head mismatch: the ledger records ' + feature.head + ', received ' + args.oldHeadRef);
      requireValue(!Object.values(feature.tasks).some(t => t.status === 'in_progress'),
        'A task is active. Suspend it (suspend_issue), then reconcile, then resume it');
      // The old chain must still be real in Git (the pre-rebase commits remain in the object store).
      verifyHistory(repository, feature);
      return { feature, before, planned: planRewrite(repository, feature, args) };
    };

    // Idempotent: the ledger already records this rewrite (a repeat, or a retry after a lost response).
    // This needs no clean tree and is checked before the preconditions, which assume it is not recorded yet.
    const known = await readFeature(repository, args.featureId, options);
    const last = known.epochs?.at(-1);
    if (known.head === args.headRef && known.base === args.upstreamBaseRef && last?.head === args.oldHeadRef)
      return { ...result('PASSED', 'Already recorded'), recovered: true, evidenceRef: last.verification };
    requireValue(args.headRef !== args.oldHeadRef, 'No history change to reconcile');
    const first = await preconditions();
    const { feature } = first;

    const design = approvedDesign(repository, feature);
    const requirements = featureRequirements(feature, design) + foreignHistoryRequirements(feature) +
      '\n\nREBASE RECOVERY: only the completed task prefix is implemented; pending criteria remain deferred. Review the entire rebased prefix against the new upstream, ' +
      'including conflict resolutions, regressions and interfaces. Earlier receipts are historical and do not verify rewritten trees.\nPrevious base: ' + feature.base +
      '\nNew upstream base: ' + args.upstreamBaseRef;
    const binding = { feature_id: args.featureId, design_ref: args.designRef, baseline: args.upstreamBaseRef, head: args.headRef,
      tree: first.before.tree, branch: args.branch, task_revision: feature.task_revision, plan_digest: digest(JSON.stringify(plan)) };
    const base = { kind: 'history-rewrite-verification', binding, plan, oldHead: args.oldHeadRef, previousBase: feature.base,
      newHistory: first.planned.history, requirements, before: first.before };

    const record_ = async (extra) => { verification = { ...base, ...extra }; return retainFeatureEvidence(repository, verification); };
    const commitRewrite = async (evidenceRef) => {
      await record(repository, args.featureId, { old_head: args.oldHeadRef, new_head: first.planned.newHead, new_base: first.planned.newBase,
        history: first.planned.history, verification: evidenceRef }, options);
    };

    if (args.resumeEvidenceRef) {
      const stored = await readFeatureEvidence(repository, args.resumeEvidenceRef, { featureId: args.featureId });
      requireValue(stored.kind === 'history-rewrite-verification' && stored.result?.status === 'PASSED' &&
        equal(stored.binding, binding) && equal(stored.newHistory, first.planned.history) && equal(stored.plan, plan) && stored.requirements === requirements,
      'The retained verification is stale or covers a different rebase');
      await commitRewrite(args.resumeEvidenceRef);
      return { ...stored.result, evidenceRef: args.resumeEvidenceRef, binding, recovered: true };
    }

    const unchanged = async () => {
      context.abort?.throwIfAborted(); monitor?.assert();
      const current = await preconditions();
      requireValue(equal(first.planned, current.planned) && equal(first.before, current.before) && first.feature.task_revision === current.feature.task_revision,
        'Source, branch, history or task state changed during verification');
    };
    await unchanged();
    monitor = monitorTrackedInputs(repository);
    const checks = [];
    let outcome;
    for (const check of plan.checks) {
      const output = await runCheck(check.command, { cwd: repository, signal: context.abort, timeoutMs: plan.timeoutMs });
      checks.push({ name: check.name, definition: check, ...output, meaningful: meaningful(check, output) });
      await unchanged();
      if (output.problem || output.exit_code === null) { outcome = result('BLOCKED', 'Check indeterminate: ' + (output.problem ?? check.name)); break; }
      if (output.exit_code !== 0) { outcome = result('NEEDS_DESIGN', 'Rebased project check failed: ' + check.name); break; }
      if (!checks.at(-1).meaningful) { outcome = result('BLOCKED', 'Meaningful coverage not established: ' + check.name); break; }
    }
    let review = null;
    if (!outcome) {
      review = await reviewChanges({ ...plan.review, repository, baseRef: args.upstreamBaseRef, headRef: args.headRef,
        requirements: reviewScope(requirements, checks) }, context, options.reviewOptions);
      review.requirementsDigest = digest(reviewScope(requirements, checks));
      await unchanged();
      outcome = result(review.status === 'APPROVED' ? 'PASSED' : review.status === 'CHANGES_REQUESTED' ? 'NEEDS_DESIGN' : 'BLOCKED',
        review.reason ?? review.message ?? 'Independent review indeterminate');
    }
    reference = await record_({ checks, review, result: outcome, after: await snapshot(repository) });
    // Record the rewrite only after the verification is retained, so a lost response can resume from it.
    await unchanged();
    if (outcome.status === 'PASSED') await commitRewrite(reference);
    return { ...outcome, evidenceRef: reference, binding, checks, review };
  } catch (error) {
    let diagnosticEvidenceRef;
    if (verification && repository && !reference) {
      try { diagnosticEvidenceRef = await retainFeatureEvidence(repository, { ...verification, result: result('BLOCKED', error.message) }); } catch {}
    }
    return { ...result('BLOCKED', error.message), evidenceRef: reference, diagnosticEvidenceRef,
      recovery: 'Nothing was changed in Scaffold or Git. Inspect retained evidence and the actual Git state; never edit the ledger or reset work' };
  } finally { monitor?.close(); }
}

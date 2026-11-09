// Native adoption of a user-approved execution baseline for an UNSTARTED feature.
//
// The feature's original baseline, authorization, requirements and designs are
// never rewritten. An authenticated adoption record names a later commit as the
// point where task checkpoints begin. The commits in between are NOT checkpoints
// and are NOT verified: final validation still reviews original baseline..HEAD,
// and its requirements name the adopted commits explicitly.
//
// Persistence is one atomic Git ref transaction (create-only, so exactly one
// concurrent writer wins). The evidence record alone confers no authority; only
// the retained ref pointing at it does, so an interrupted write is inert.
import { createHash } from 'node:crypto';
import path from 'node:path';
import { isDeepStrictEqual as equal } from 'node:util';
import { git, assertNoGitOperation } from '../git/tree.mjs';
import { snapshot } from '../git/snapshot.mjs';
import { retainFeatureEvidence, readFeatureEvidence, featureEvidenceReferences,
  taskEvidenceReferences, readEvidence } from '../evidence/store.mjs';
import { featureInstanceId } from './feature-instance.mjs';
import { authorizationReference } from '../authorization/feature.mjs';

export const ADOPTION_FORMAT = 'pi.baseline-adoption/v1';
const MAX_COMMITS = 200, MAX_PATHS = 500;
const ELIGIBLE_STATUSES = ['pending', 'decomposed'];
const requireValue = (ok, message) => { if (!ok) throw new Error(message); };
const sha = x => /^[a-f0-9]{40}$/.test(x ?? '');
const ZERO = '0'.repeat(40);

export function adoptionRefPrefix(feature) {
  const key = createHash('sha256').update(feature.id + '\0' + (featureInstanceId(feature) ?? '')).digest('hex').slice(0, 32);
  return 'refs/pi-baseline-adoptions/' + key;
}
const tryGit = (repository, args, options) => { try { return git(repository, args, options); } catch { return undefined; } };

function commitsBetween(repository, from, to) {
  const lines = git(repository, ['rev-list', '--reverse', from + '..' + to]).split('\n').filter(Boolean);
  requireValue(lines.length > 0 && lines.length <= MAX_COMMITS, 'Adoption requires 1..' + MAX_COMMITS + ' intervening commits');
  return lines.map(commit => ({ commit, parents: git(repository, ['show', '-s', '--format=%P', commit]).split(' ').filter(Boolean),
    subject: git(repository, ['show', '-s', '--format=%s', commit]).slice(0, 200) }));
}

// Authenticate the adoption in force for this feature instance, or null.
// Throws on corrupt, tampered or mismatched evidence so execution fails closed.
export async function findAdoption(repository, feature) {
  const prefix = adoptionRefPrefix(feature);
  const blob = tryGit(repository, ['rev-parse', '--verify', '--quiet', prefix + '/record']);
  if (!blob) return null;
  const reference = git(repository, ['cat-file', '-p', blob]);
  const record = await readFeatureEvidence(repository, reference);
  const s = record.scope;
  requireValue(record.kind === 'baseline-adoption' && record.format === ADOPTION_FORMAT && s, 'Baseline adoption record is malformed');
  requireValue(s.featureId === feature.id && s.instanceId === featureInstanceId(feature) && s.designRef === feature.design_ref &&
    s.branch === feature.branch && s.originalBaseline === feature.original_baseline && sha(s.adoptedBaseline) && s.adoptedBaseline !== s.originalBaseline,
  'Baseline adoption belongs to a different feature identity, branch or original baseline');
  const authorization = await readFeatureEvidence(repository, s.authorizationRef);
  requireValue(authorization.kind === 'feature-authorization' && authorization.scope?.featureId === feature.id &&
    authorization.scope.baseline === s.originalBaseline && authorization.scope.designRef === feature.design_ref &&
    authorization.scope.branch === feature.branch && authorization.scope.instanceId === s.instanceId,
  'Original feature authorization no longer matches the adoption');
  requireValue(tryGit(repository, ['merge-base', '--is-ancestor', s.originalBaseline, s.adoptedBaseline]) !== undefined,
    'Adopted baseline does not descend from the original baseline');
  requireValue(equal(commitsBetween(repository, s.originalBaseline, s.adoptedBaseline), s.commits) &&
    git(repository, ['rev-parse', s.originalBaseline + '^{tree}']) === s.originalTree &&
    git(repository, ['rev-parse', s.adoptedBaseline + '^{tree}']) === s.adoptedTree,
  'Adopted commit range changed or evidence is corrupt');
  requireValue(tryGit(repository, ['rev-parse', '--verify', '--quiet', prefix + '/original']) === s.originalBaseline &&
    tryGit(repository, ['rev-parse', '--verify', '--quiet', prefix + '/adopted']) === s.adoptedBaseline,
  'Retained adoption refs are missing or changed');
  return { reference, baseline: s.adoptedBaseline, original: s.originalBaseline, record };
}

export const executionBaseline = async (repository, feature) =>
  (await findAdoption(repository, feature))?.baseline ?? feature.original_baseline;

// Requirements text appended to final validation so adopted commits are reviewed, never exempted.
export function adoptionRequirements(adoption) {
  const s = adoption.record.scope;
  return '\n\nBASELINE ADOPTION (' + adoption.reference + '): the user approved executing from ' + s.adoptedBaseline +
    ' instead of the original baseline ' + s.originalBaseline + '. The following commits are NOT task checkpoints and were NOT verified by task review; ' +
    'they are part of this review scope. Assess them for feature-relevant changes, regressions and interactions:\n' +
    s.commits.map(c => '- ' + c.commit + ' ' + c.subject).join('\n') + '\nChanged paths: ' + s.changedPaths.join(', ') + (s.pathsTruncated ? ' (truncated)' : '');
}

async function ineligibility(repository, feature) {
  const reasons = [];
  const instanceId = featureInstanceId(feature);
  for (const t of Object.values(feature.tasks ?? {})) {
    if (!ELIGIBLE_STATUSES.includes(t.status)) reasons.push('Task ' + t.id + ' is ' + t.status);
    if (t.delivery) reasons.push('Task ' + t.id + ' has delivery state');
    if (t.suspension) reasons.push('Task ' + t.id + ' is suspended');
  }
  for (const reference of await taskEvidenceReferences(repository)) {
    const r = await readEvidence(repository, reference); // corrupt evidence throws and blocks
    if (r.task?.featureId === feature.id && r.featureInstanceId === instanceId) reasons.push('Implementation attempt evidence exists: ' + reference);
  }
  for (const reference of await featureEvidenceReferences(repository)) {
    const r = await readFeatureEvidence(repository, reference);
    if (!['feature-authorization', 'baseline-adoption'].includes(r.kind) && (r.binding?.feature_id === feature.id || r.feature?.id === feature.id))
      reasons.push('Feature ' + r.kind + ' evidence exists: ' + reference);
  }
  return reasons;
}

// Read-only derivation of everything the user is asked to approve; throws if ineligible.
async function derive(args, feature, context, { allowIneligible = false } = {}) {
  context.abort?.throwIfAborted();
  const repository = path.resolve(git(context.directory, ['rev-parse', '--show-toplevel']));
  requireValue(sha(args.originalBaseRef) && sha(args.newBaseRef), 'Original and new baseline must be full SHAs');
  requireValue(feature?.id === args.featureId, 'Cannot inspect feature');
  requireValue(feature.original_baseline === args.originalBaseRef,
    'Original baseline mismatch: Scaffold records ' + feature.original_baseline + ', received ' + args.originalBaseRef);
  await assertNoGitOperation(repository);
  const branch = git(repository, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  requireValue(branch === feature.branch, 'Branch mismatch: current ' + branch + ', feature ' + feature.branch);
  const head = git(repository, ['rev-parse', 'HEAD']);
  requireValue(head === args.newBaseRef, 'Stale HEAD: current ' + head + ', approval names ' + args.newBaseRef);
  requireValue(head !== feature.original_baseline, 'HEAD already equals the original baseline; nothing to adopt');
  requireValue(tryGit(repository, ['merge-base', '--is-ancestor', feature.original_baseline, head]) !== undefined,
    'Original baseline is not an ancestor of HEAD (history was rewritten). Baseline adoption is not rebase recovery; use reconcile_feature_rebase');
  const before = await snapshot(repository);
  requireValue(before.clean && !before.bookkeepingVisible && before.head === head, 'Adoption requires a clean source tree and index with Scaffold ignored');
  const { scope: authorized, reference: authorizationRef } = await authorizationReference(
    { featureId: feature.id, designRef: feature.design_ref, branch: feature.branch, featureBaseRef: feature.original_baseline }, { feature }, context);
  requireValue(authorizationRef, 'Original feature authorization is missing; restore evidence, never reapprove to reset history');
  const reasons = await ineligibility(repository, feature);
  if (!allowIneligible) requireValue(reasons.length === 0, 'Feature has started and is not eligible for baseline adoption: ' + reasons.join('; '));
  const commits = commitsBetween(repository, feature.original_baseline, head);
  requireValue(!commits.some(c => /^Pi-Task-Checkpoint: /m.test(git(repository, ['show', '-s', '--format=%B', c.commit]))),
    'Intervening range contains task checkpoint commits; the feature has already started');
  const paths = git(repository, ['diff', '--name-only', '-z', feature.original_baseline, head]).split('\0').filter(Boolean);
  const scope = { repository, featureId: feature.id, instanceId: featureInstanceId(feature), designRef: feature.design_ref, branch,
    originalBaseline: feature.original_baseline, adoptedBaseline: head, authorizationRef, commits,
    originalTree: git(repository, ['rev-parse', feature.original_baseline + '^{tree}']), adoptedTree: git(repository, ['rev-parse', head + '^{tree}']),
    changedPaths: paths.slice(0, MAX_PATHS), pathsTruncated: paths.length > MAX_PATHS };
  return { repository, scope, taskRevision: feature.task_revision, before, reasons, authorized };
}

export async function adoptionEligibility(args, { feature }, context = {}) {
  try {
    const d = await derive(args, feature, context, { allowIneligible: true });
    return { eligible: d.reasons.length === 0, reasons: d.reasons, scope: d.scope };
  } catch (error) { return { eligible: false, reasons: [error.message] }; }
}

// `readFeature()` re-reads current Scaffold state; `confirm(scope)` is a trusted user-approval callback.
export async function adoptFeatureBaseline(args, { readFeature }, context = {}, options = {}) {
  let repository;
  try {
    let feature = await readFeature();
    repository = path.resolve(git(context.directory, ['rev-parse', '--show-toplevel']));
    const prefix = adoptionRefPrefix(feature);
    const existing = async () => { const found = await findAdoption(repository, feature); return found; };
    const recovered = found => ({ ok: true, status: 'ADOPTED', recovered: true, reference: found.reference,
      originalBaseline: found.original, adoptedBaseline: found.baseline, scope: found.record.scope });
    // Idempotent: a repeat or a retry after a lost response needs no clean tree or eligibility.
    const prior = await existing();
    if (prior) {
      requireValue(prior.baseline === args.newBaseRef && prior.original === args.originalBaseRef,
        'A different baseline is already adopted: ' + prior.baseline);
      return recovered(prior);
    }
    const first = await derive(args, feature, context);
    const approved = await options.confirm?.(first.scope);
    requireValue(approved === true, 'Explicit user approval of this baseline adoption is required');
    context.abort?.throwIfAborted();
    feature = await readFeature();
    const second = await derive(args, feature, context);
    requireValue(equal(first.scope, second.scope) && first.taskRevision === second.taskRevision && equal(first.before, second.before),
      'Repository or feature changed during approval; nothing was adopted');
    let reference;
    for (let attempt = 0; !reference; attempt++) {
      try { reference = await retainFeatureEvidence(repository, { kind: 'baseline-adoption', format: ADOPTION_FORMAT,
        scope: second.scope, taskRevision: second.taskRevision }); }
      catch (error) { if (error.code !== 'EEXIST' || attempt > 4) throw error; await new Promise(r => setTimeout(r, 2)); }
    }
    await options.interrupt?.('afterRecord');
    const unchanged = await derive(args, await readFeature(), context);
    requireValue(equal(unchanged.scope, second.scope) && equal(unchanged.before, second.before), 'Repository changed before adoption was retained; nothing was adopted');
    const blob = git(repository, ['hash-object', '-w', '--stdin'], { input: reference });
    try {
      git(repository, ['update-ref', '--stdin'], { input: 'start\ncreate ' + prefix + '/record ' + blob + '\ncreate ' + prefix + '/original ' +
        second.scope.originalBaseline + '\ncreate ' + prefix + '/adopted ' + second.scope.adoptedBaseline + '\nprepare\ncommit\n' });
    } catch (error) {
      const winner = tryGit(repository, ['rev-parse', '--verify', '--quiet', prefix + '/record']) && await existing();
      if (winner && equal(winner.record.scope, second.scope)) return recovered(winner);
      throw winner ? new Error('A different baseline is already adopted: ' + winner.baseline) : error;
    }
    await options.interrupt?.('afterRetention');
    return { ok: true, status: 'ADOPTED', reference, originalBaseline: second.scope.originalBaseline,
      adoptedBaseline: second.scope.adoptedBaseline, scope: second.scope };
  } catch (error) {
    return { ok: false, status: 'BLOCKED', message: error.message,
      recovery: 'Nothing was changed in Scaffold or Git history. Inspect with inspect_feature_drift; retry only with the exact old and new commits you approve.' };
  }
}

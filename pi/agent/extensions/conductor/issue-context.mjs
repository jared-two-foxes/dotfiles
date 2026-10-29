// Data-only, content-addressed issue handoffs. Never authorizes execution or changes graph/source.
import path from 'node:path';
import { lstat, mkdir, readFile, writeFile, realpath, readdir } from 'node:fs/promises';
import { isDeepStrictEqual as equal } from 'node:util';
import { git, assertNoGitOperation } from './git-tree.mjs';
import { digest, snapshot, readEvidence, taskEvidenceReferences } from './evidence.mjs';
import { authenticateAttemptChain, assertLatestAttempt } from './task-chain.mjs';
import { scaffoldTasks } from '../scaffold/adapter.mjs';
const requireValue = (ok, message) => { if (!ok) throw new Error(message); };
async function directory(repository, create = false) {
  const dir = path.resolve(repository, git(repository, ['rev-parse', '--git-path', 'pi-issue-context']));
  try { const s = await lstat(dir); requireValue(s.isDirectory() && !s.isSymbolicLink(), 'Unsafe issue handoff directory'); }
  catch (e) { if (e.code !== 'ENOENT' || !create) throw e; await mkdir(dir, { mode: 0o700 }); }
  return dir;
}
async function scoped(repository, featureId, taskId, options) {
  const r = await scaffoldTasks({ operation: 'issue', feature_id: featureId, task_id: taskId },
    { directory: repository }, options.scaffoldOptions);
  requireValue(r.ok, r.message ?? 'Cannot inspect issue'); return r.data.context;
}
async function attempt(repository, binding) {
  const receipts = [];
  for (const reference of await taskEvidenceReferences(repository)) {
    const record = await readEvidence(repository, reference);
    if (equal(record.task, binding) && record.kind !== 'issue-suspension') receipts.push({ reference, record });
  }
  if (!receipts.length) return null;
  const replaced = new Set(receipts.flatMap(({ record }) => [record.args?.previousAttempt, record.startedReference]).filter(Boolean));
  const candidates = receipts.filter(r => !replaced.has(r.reference));
  const max = Math.max(...receipts.map(r => r.record.attempt));
  const latest = candidates.filter(r => r.record.attempt === max);
  requireValue(latest.length === 1, 'Ambiguous receipt chain; inspect retained evidence before preparing context');
  const { reference, record } = latest[0];
  await authenticateAttemptChain(repository, reference, binding);
  await assertLatestAttempt(repository, reference, binding, record.attempt);
  const c = record.result.conductor ?? record.result.actualResult?.conductor;
  const findings = c?.review?.findings ?? [];
  return JSON.parse(JSON.stringify({ reference, consumed_attempts: record.attempt, remaining_attempts: Math.max(0, 5 - record.attempt),
    matches_source: equal(await snapshot(repository), record.after),
    status: record.result.status, stage: record.result.stage, reason: record.result.reason,
    latest_findings: findings.slice(0, 24).map(f => ({ severity: f.severity, message: String(f.message ?? '').slice(0, 800),
      path: f.path ?? f.file, line: f.line })),
    findings_excerpted: findings.length > 24 || findings.some(f => String(f.message ?? '').length > 800),
    details: { tool: 'inspect_issue_attempt', reference },
    note: 'Latest findings are an excerpt, not a resolution of earlier findings. Original requirements and complete prior diagnostics remain in the authenticated receipt chain.' }));
}
function notes(value = {}) {
  requireValue(value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).every(k => ['next_action', 'source_locations', 'open_questions'].includes(k)), 'Invalid handoff notes');
  requireValue(value.next_action === undefined || typeof value.next_action === 'string', 'Invalid next action');
  for (const k of ['source_locations', 'open_questions']) requireValue(value[k] === undefined ||
    (Array.isArray(value[k]) && value[k].length <= 32 && value[k].every(x => typeof x === 'string' && x.length <= 1000)), 'Invalid handoff notes');
  requireValue(JSON.stringify(value).length <= 12000, 'Handoff notes exceed 12000 characters'); return value;
}
export async function prepareIssueHandoff(args, context = {}, options = {}) {
  let reference;
  try {
    const repository = await realpath(git(context.directory, ['rev-parse', '--show-toplevel']));
    await assertNoGitOperation(repository); context.abort?.throwIfAborted();
    const capsule = await scoped(repository, args.featureId, args.taskId, options);
    const before = await snapshot(repository);
    requireValue(!before.bookkeepingVisible, 'Scaffold state must be ignored');
    const binding = { featureId: args.featureId, taskId: args.taskId, designRef: capsule.feature.design_ref };
    const latest = await attempt(repository, binding);
    const record = { schema: 'pi.issue-context/v1', repository, binding, recorded_at: new Date().toISOString(),
      capsule, git: before, attempt: latest, notes: notes(args.notes),
      authority: 'Context only. Notes are agent-authored navigation aids, never approval, PASSED evidence or permission to reset attempts.' };
    const bytes = JSON.stringify(record), hash = digest(bytes);
    await writeFile(path.join(await directory(repository, true), hash + '.json'), bytes, { flag: 'wx', mode: 0o600 });
    reference = 'pi-issue-context:sha256:' + hash;
    const result = await inspectIssueHandoff({ reference }, context, options);
    requireValue(result.ok && result.applicable, result.message ?? result.reason ?? 'Context changed while saving handoff');
    return result;
  } catch (e) { return { ok: false, reference, message: e.message }; }
}
export async function inspectIssueHandoff(args, context = {}, options = {}) {
  try {
    const repository = await realpath(git(context.directory, ['rev-parse', '--show-toplevel']));
    if (!args.reference) {
      requireValue(typeof args.featureId === 'string' && typeof args.taskId === 'string', 'Supply a reference or explicit featureId/taskId');
      const dir = await directory(repository), candidates = [];
      for (const name of await readdir(dir)) {
        if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
        const file = path.join(dir, name), stat = await lstat(file);
        requireValue(stat.isFile() && !stat.isSymbolicLink(), 'Unsafe issue handoff file');
        const bytes = await readFile(file, 'utf8');
        requireValue(digest(bytes) === name.slice(0, -5), 'Issue handoff digest mismatch');
        const r = JSON.parse(bytes);
        if (r.binding?.featureId === args.featureId && r.binding?.taskId === args.taskId)
          candidates.push({ reference: 'pi-issue-context:sha256:' + name.slice(0, -5), time: r.recorded_at });
      }
      requireValue(candidates.length, 'No saved issue handoff; prepare one from current state');
      candidates.sort((a, b) => b.time.localeCompare(a.time) || b.reference.localeCompare(a.reference));
      return inspectIssueHandoff({ reference: candidates[0].reference }, context, options);
    }
    const match = /^pi-issue-context:sha256:([a-f0-9]{64})$/.exec(args.reference ?? '');
    requireValue(match, 'Invalid issue handoff reference');
    const file = path.join(await directory(repository), match[1] + '.json');
    const stat = await lstat(file); requireValue(stat.isFile() && !stat.isSymbolicLink(), 'Unsafe issue handoff file');
    const bytes = await readFile(file, 'utf8'); requireValue(digest(bytes) === match[1], 'Issue handoff digest mismatch');
    const record = JSON.parse(bytes);
    requireValue(record.schema === 'pi.issue-context/v1' && record.repository === repository, 'Issue handoff repository/schema mismatch');
    try {
      await assertNoGitOperation(repository); context.abort?.throwIfAborted();
      const current = await scoped(repository, record.binding.featureId, record.binding.taskId, options);
      requireValue(equal(current, record.capsule), 'Graph/design/lifecycle changed; prepare a fresh issue handoff');
      requireValue(equal(await snapshot(repository), record.git), 'Git source, index or HEAD changed; prepare a fresh issue handoff');
      requireValue(equal(await attempt(repository, record.binding), record.attempt), 'Attempt chain changed; prepare a fresh issue handoff');
      return { ok: true, applicable: true, reference: args.reference, handoff: record };
    } catch (e) {
      // Stale records are inspectable by reference, but are not fed back as current context.
      return { ok: true, applicable: false, reference: args.reference, reason: e.message,
        refresh: { tool: 'prepare_issue_handoff', featureId: record.binding.featureId, taskId: record.binding.taskId } };
    }
  } catch (e) { return { ok: false, message: e.message }; }
}

export async function inspectIssueAttempt(args, context = {}) {
  try {
    const repository = await realpath(git(context.directory, ['rev-parse', '--show-toplevel']));
    const record = await readEvidence(repository, args.reference);
    await authenticateAttemptChain(repository, args.reference, record.task);
    await assertLatestAttempt(repository, args.reference, record.task, record.attempt);
    const { input, ...fixed } = record.args;
    return { ok: true, reference: args.reference, task: record.task, consumed_attempts: record.attempt,
      matches_source: equal(await snapshot(repository), record.after), continuation: { ...fixed, previousAttempt: args.reference },
      status: record.result.status, note: 'Exact retained requirements/checks; no source operations. Inspect full receipt by reference for diagnostics. Reconcile phase, source and approvals before execution.' };
  } catch (e) { return { ok: false, message: e.message }; }
}

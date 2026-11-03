// Deterministic evidence-backed pause decisions; never starts retries or a scheduler.
import { createHash } from 'node:crypto';
import { readFile, stat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
const digest = v => createHash('sha256').update(JSON.stringify(v)).digest('hex');
export function diagnosticSignature(value) {
  return digest(String(value).replace(/\x1b\[[0-9;]*m/g, '').replace(/\b\d+(?:\.\d+)?(?:ms|s)\b/g, '<time>')
    .replace(/\b\d{4}-\d{2}-\d{2}[T ][\d:.]+Z?\b/g, '<timestamp>').replace(/:\d+:\d+\b/g, ':<position>')
    .replace(/(?:\/tmp|[A-Z]:\\Temp)[/\\][^\s:]+/g, '<temp>').split('\n').map(s => s.trim()).filter(Boolean).sort());
}
export function failureObservation(record) {
  const r = record.result, c = r.conductor ?? r.actualResult?.conductor;
  let category = 'evidence_integrity', diagnostics = r.reason ?? r.message;
  const review = c?.review;
  if (r.reason === 'RESOURCE_PAUSED') { category = 'resource'; diagnostics = r.message; }
  else if (c?.failure) { category = c.failure.category; diagnostics = c.failure.code; }
  else if (review) {
    category = ({ AUTHENTICATION_FAILURE: 'authentication', NETWORK_FAILURE: 'network',
      PROVIDER_FAILURE: 'provider', RATE_LIMITED: 'network', MODEL_FAILURE: 'provider',
      BUDGET_EXHAUSTED: 'resource', LIMIT_EXCEEDED: 'resource', CANCELLED: 'resource',
      REVIEW_ENGINE_NOT_AVAILABLE: 'review_engine', SESSION_STALLED: 'review_engine' })[review.reason] ?? 'review_finding';
    diagnostics = review.status === 'CHANGES_REQUESTED' ? review.findings.filter(f => f.blocking)
      .map(f => [f.path, f.message, f.recommendation].join(':')).sort().join('\n') : review.reason;
  } else if (c?.phase === 'verification') {
    const check = c.checks.find(v => v.status !== 'PASSED');
    const command = record.args.checks?.find(v => v.name === check?.name)?.command ?? [];
    const cmd = command.join(' ');
    category = /fmt|format/.test(cmd) ? 'format' : /clippy|lint/.test(cmd) ? 'lint' :
      /test|pytest|vitest/.test(cmd) ? 'test' : 'compile';
    if (/\berror\[E\d+\]|could not compile|\berror TS\d+|\berror CS\d+/i.test(
      String(check?.stderr ?? '') + '\n' + String(check?.stdout ?? ''))) category = 'compile';
    if (check?.exit_code == null || check?.problem) category = 'invocation';
    diagnostics = check?.stderr + '\n' + check?.stdout;
  } else if (c?.phase === 'execution') {
    category = c.execution ? 'executor_application' : 'invocation'; diagnostics = c.execution?.error ?? c.error;
  } else if (r.reason === 'PROTOCOL_MISMATCH') category = 'protocol_integrity';
  const passed = (c?.checks ?? []).filter(v => v.status === 'PASSED' || v.exit_code === 0)
    .map(v => v.name).sort();
  return { category, signature: diagnosticSignature([category, diagnostics]), tree: record.after?.tree,
    passed, reviewReached: c?.phase === 'review', at: Date.parse(record.recordedAt),
    environment: record.args.reviewEnvironment };
}
const substantive = new Set(['compile', 'format', 'lint', 'test', 'review_finding', 'executor_application']);
export function stallDecision(records, args) {
  const lastBridge = records.findLastIndex(r => ['issue-handoff', 'rebase-handoff'].includes(r.kind) &&
    r.args.baseRef !== r.recovery?.featureBaseRef);
  const observations = records.slice(lastBridge + 1).filter(r => r.startedReference && r.result.status !== 'PASSED')
    .map(failureObservation).filter(o => substantive.has(o.category)).slice(-8);
  const last = observations.at(-1);
  if (!last) return null;
  const repeats = observations.filter(o => o.category === last.category && o.signature === last.signature);
  const recurring = repeats.length >= 3;
  const trees = observations.map(o => o.tree);
  const cycling = trees.length >= 4 && trees.at(-1) === trees.at(-3) && trees.at(-2) === trees.at(-4) &&
    (observations.at(-1).signature === observations.at(-3).signature || repeats.length >= 2);
  // A newly passed stage only counts if the failing obligation does not recur.
  if (!recurring && !cycling) return null;
  const diagnosis = args.contextUpdates?.find(u => u.kind === 'diagnose' && u.signature === last.signature &&
    typeof u.text === 'string' && u.text.trim());
  const alreadyProbed = records.some(r => r.args.contextUpdates?.some(u => u.kind === 'diagnose' && u.signature === last.signature));
  if (diagnosis && !alreadyProbed && (JSON.parse(args.input).operations.length ||
      args.contextUpdates.some(u => ['repair_check', 'revise_design'].includes(u.kind)))) return null;
  return { reason: 'DIAGNOSIS_REQUIRED', signature: last.signature, observations,
    message: 'Equivalent unresolved failures or recurring source states; record a concrete diagnosis and changed correction/plan. History and source are retained.' };
}

async function executable(program) {
  const names = program.includes('/') || program.includes('\\') ? [program] :
    (process.env.PATH ?? '').split(path.delimiter).flatMap(p => process.platform === 'win32'
      ? [path.join(p, program), path.join(p, program + '.exe')] : [path.join(p, program)]);
  for (const name of names) try { const p = await realpath(name); return [p, digest((await readFile(p)).toString('base64'))]; } catch {}
  return [program, 'missing'];
}
export async function reviewEnvironment(args) {
  const credentials = path.join(homedir(), '.secrets', 'opencode-key');
  let generation = 'absent';
  try { const s = await stat(credentials); generation = [s.mtimeMs, s.ctimeMs, s.ino, s.size]; } catch {}
  return digest([await executable(process.env.REVIEW_CLI_BIN ?? 'review-cli'),
    args.reviewModel ?? 'opencode/gpt-6.1-sol', process.env.REVIEW_PROVIDER_ROOT ?? '', generation,
    // Presence only: never retain a secret or a guessable hash of a secret.
    !!process.env.OPENCODE_API_KEY, !!process.env.OPENAI_API_KEY]);
}
export function infrastructureDecision(records, environment, now = Date.now(), probe = false) {
  const lastRecord = records.filter(r => r.startedReference).at(-1);
  if (!lastRecord || lastRecord.result.status === 'PASSED') return null;
  const o = failureObservation(lastRecord);
  if (!['authentication', 'network', 'provider', 'review_engine', 'resource'].includes(o.category)) return null;
  if (o.category === 'resource') return { reason: 'RESOURCE_PAUSED', message:
    'Resource allowance exhausted; retain usage and explicitly revise the invocation budget before resuming.' };
  if (o.environment && o.environment !== environment) return null;
  const elapsed = now - o.at;
  // A secret rotated only in the environment has no safe persistent fingerprint.
  // One explicit no-source probe establishes availability; failed probes are
  // throttled, rather than trusting a caller assertion that repair succeeded.
  if (probe && (!lastRecord.args.reviewProbe || elapsed >= 300000)) return null;
  // Transient service failure permits one bounded probe after cooldown. Auth/setup
  // failures require an observed configuration/credential-file/executable repair.
  if (['network', 'provider'].includes(o.category) && elapsed >= 300000) return null;
  return { reason: 'INFRASTRUCTURE_PAUSED', category: o.category,
    retryAfterMs: ['network', 'provider'].includes(o.category) ? Math.max(0, 300000 - elapsed) : null,
    message: 'Review circuit is open. Preserve source and receipts; repair the relevant service/configuration before a bounded continuation.' };
}

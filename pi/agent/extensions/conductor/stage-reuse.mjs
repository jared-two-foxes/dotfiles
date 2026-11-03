// Conservative, explicitly declared check environments. Unknown ambient state disables reuse.
import path from 'node:path';
import { readFile, realpath } from 'node:fs/promises';
import { isDeepStrictEqual as equal } from 'node:util';
import { createHash } from 'node:crypto';
import { readEvidence, snapshot } from './evidence.mjs';
import { authenticNormalized, authenticateWorkflow } from './protocol.mjs';
import { verificationChecks } from './verification.mjs';
const requireValue = (ok, msg) => { if (!ok) throw new Error(msg); };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export async function checkEnvironment(repository, declaration) {
  if (!declaration) return null;
  requireValue(declaration && Object.keys(declaration).every(k => ['files', 'variables', 'executables'].includes(k)) &&
    ['files', 'variables', 'executables'].every(k => Array.isArray(declaration[k]) && declaration[k].length <= 64 &&
      declaration[k].every(v => typeof v === 'string' && v.trim() && !v.includes('\0'))), 'Invalid checkEnvironmentInputs');
  requireValue(declaration.variables.every(v => !/TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL/i.test(v)), 'Never fingerprint credential values');
  const values = [];
  for (const file of declaration.files) {
    const full = await realpath(path.resolve(repository, file));
    requireValue(full.startsWith(repository + path.sep), 'Environment file must be in the repository');
    values.push([file, hash(await readFile(full))]);
  }
  for (const name of declaration.variables) values.push([name, process.env[name] ?? null]);
  for (const program of declaration.executables) {
    const candidates = path.isAbsolute(program) ? [program] : (process.env.PATH ?? '').split(path.delimiter)
      .flatMap(p => [path.join(p, program), ...(process.platform === 'win32' ? [path.join(p, program + '.exe')] : [])]);
    let found;
    for (const p of candidates) try { found = [await realpath(p), hash(await readFile(p))]; break; } catch {}
    requireValue(found, 'Cannot fingerprint declared executable ' + program); values.push(found);
  }
  return hash(JSON.stringify(values));
}
export async function reusableCheck(repository, reference, index, currentArgs, source) {
  const prior = await readEvidence(repository, reference), c = prior.result.conductor;
  requireValue(c && authenticNormalized(c) && prior.workflow && prior.reviewSnapshot &&
    prior.reviewSnapshot.head === prior.after.head && prior.reviewSnapshot.tree === prior.after.tree &&
    prior.reviewSnapshot.digest === prior.after.digest && equal(prior.after, source), 'Reused checks lack a stable source boundary');
  authenticateWorkflow(prior.workflow, prior.request, prior.args, repository);
  requireValue(prior.args.checkEnvironment && currentArgs.checkEnvironment === prior.args.checkEnvironment &&
    equal(currentArgs.checkEnvironmentInputs, prior.args.checkEnvironmentInputs), 'Reused check environment changed');
  requireValue(equal(verificationChecks(currentArgs), verificationChecks(prior.args)), 'Reused check definitions changed');
  const check = c.checks[index - 1];
  requireValue(index > 0 && index <= c.checks.length && check?.status === 'PASSED', 'Reused check did not pass');
  for (const stream of ['stdout', 'stderr']) {
    const file = check[stream + '_path'], info = await (await import('node:fs/promises')).lstat(file);
    requireValue(info.isFile() && !info.isSymbolicLink() && info.size <= 16 * 1024 * 1024 &&
      typeof check[stream + '_sha256'] === 'string' &&
      hash(await readFile(file)) === check[stream + '_sha256'], 'Reused check logs are missing, stale or corrupted');
  }
  return check;
}
export async function reusePlan(repository, args, source) {
  if (!args.previousAttempt || !args.checkEnvironment || JSON.parse(args.input).operations.length) return null;
  try {
    const previous = await readEvidence(repository, args.previousAttempt);
    const checks = verificationChecks(args);
    for (let index = 1; index <= checks.length; index++)
      await reusableCheck(repository, args.previousAttempt, index, args, source);
    return { reference: args.previousAttempt, args, source, count: checks.length };
  } catch { return null; }
}
export async function replayCheck(stage) {
  const { reference, args, source, index, boundaryPath, last } = stage.reuse;
  requireValue(equal(await snapshot(stage.repository), source), 'Source changed before check reuse');
  requireValue(await checkEnvironment(stage.repository, args.checkEnvironmentInputs) === args.checkEnvironment,
    'Environment changed before check reuse');
  const check = await reusableCheck(stage.repository, reference, index, args, source);
  // Actual logs, including truncation checks, remain backed by the retained command.
  const stdout = await readFile(check.stdout_path), stderr = await readFile(check.stderr_path);
  if (last) {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(boundaryPath, JSON.stringify(await snapshot(stage.repository)), { flag: 'wx', mode: 0o600 });
  }
  process.stdout.write(stdout); process.stderr.write(stderr);
  return { exit_code: check.exit_code, signal: null, reusedFrom: { reference, index } };
}

import path from 'node:path';
import { lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import { isDeepStrictEqual as equal } from 'node:util';
import { digest, readEvidence, snapshot } from './evidence.mjs';
import { git } from './git-tree.mjs';
import { authenticateWorkflow } from './protocol.mjs';
import { verificationChecks } from './verification.mjs';

function requireValue(ok, message) {
  if (!ok) throw new Error(message);
}

// Only forward counts, never arbitrary test output, stack traces or environment values.
export function testCounts(...streams) {
  const counts = new Set();
  for (const stream of streams)
    for (const match of stream.matchAll(/\b(?:(\d{1,9})[ \t]+(?:tests?[ \t]+)?(passed|passing|failed|ignored|skipped)|(passed|failed|skipped)[ \t]*[:=][ \t]*(\d{1,9}))\b/gi))
      counts.add((match[1] ?? match[4]) + ' ' + (match[2] ?? match[3]).toLowerCase());
  return [...counts].slice(0, 24);
}

export function reviewEvidence(plan, runner, source) {
  const { args, startedReference, attempt } = plan;
  const checks = verificationChecks(args).map(({ name, command }, i) => {
    const index = i + 1;
    const check = runner.commands[index], receipt = runner.receipts[index];
    requireValue(check?.name === name && check.status === 'PASSED' && Array.isArray(check.testCounts) && receipt &&
      equal(receipt.sourceBefore, source) && equal(receipt.sourceAfter, source),
    'Check evidence is missing or belongs to a different source/index snapshot');
    return {
      name, command, exitCode: receipt.exit_code, status: check.status,
      ...(check.condition ? { validatorExitCode: check.condition.exit_code } : {}),
      testCounts: check.testCounts,
      outputPreviewTruncated: check.stdout_truncated || check.stderr_truncated,
      stageIndex: index, stdoutSha256: check.stdout_sha256, stderrSha256: check.stderr_sha256,
      commandReceiptSha256: digest(JSON.stringify(receipt)),
      ...(runner.conditionReceipts[index] ? {
        conditionReceiptSha256: digest(JSON.stringify(runner.conditionReceipts[index])),
      } : {}),
      ...(receipt.reusedFrom ? { reusedFrom: receipt.reusedFrom } : {}),
      resolvesCheckObligations: (args.deliveryContext?.obligations ?? [])
        .filter(o => o.status === 'open' && o.id.startsWith('check-') &&
          o.source?.replace(/^attempt:\d+:check:/, '') === name)
        .map(o => o.id),
    };
  });
  return { schema: 'pi.task-review-evidence/v1', gate: 'targeted-task', attempt, startedReference,
    tree: source.tree, head: source.head, sourceDigest: source.digest, checks };
}

export function reviewHandoff(workflow, evidence) {
  const original = JSON.parse(workflow.request.commands.at(-1).args[1]);
  const root = workflow.request.output_directory;
  const requirementsPath = path.join(root, 'review-evidence.md');
  const requestPath = path.join(root, 'review-evidence.json');
  const requirements = workflow.inputs.requirements +
    '\n\nTask verification scope: assess the approved task and its targeted checks. ' +
    'The full-workspace gate runs separately at final feature validation. ' +
    'Conductor authenticated the following results for the reviewed source tree. ' +
    'Use them as check evidence without rerunning commands or inspecting private logs. ' +
    'For each matching failed-check obligation, cite the passing result and its stage receipt; ' +
    'assess any separate code findings against the source.\n' + JSON.stringify(evidence);
  const request = JSON.stringify({ ...workflow.inputs.review, requirements: requirementsPath });
  const files = [[requestPath, request], [requirementsPath, requirements]];
  const identity = { schema: evidence.schema, inputs: files.map(([file, contents]) => ({ file, sha256: digest(contents) })) };
  const args = original.args.map(arg => arg === path.join(root, 'review.json') ? requestPath : arg);
  return { args: [workflow.request.commands.at(-1).args[0], JSON.stringify({
    ...original, args, inputs: [...original.inputs, ...identity.inputs],
  })], files, identity };
}

export async function prepareReviewHandoff(stage) {
  const planFile = await lstat(stage.reviewPlan);
  requireValue(planFile.isFile() && !planFile.isSymbolicLink(), 'Unsafe review handoff plan');
  const plan = JSON.parse(await readFile(stage.reviewPlan, 'utf8'));
  const root = plan.workflow.request.output_directory;
  requireValue(plan.repository === stage.repository && stage.reviewPlan === path.join(root, 'delivery.json') &&
    await realpath(root) === root && equal(plan.workflow.request.commands.at(-1), stage.command),
  'Invalid review handoff plan');
  const specs = authenticateWorkflow(plan.workflow, plan.workflow.request, plan.args, plan.repository);
  const started = await readEvidence(plan.repository, plan.startedReference);
  requireValue(started.result.stage === 'STARTED' && started.attempt === plan.attempt &&
    equal(started.args, plan.args), 'Review handoff is missing its retained attempt intent');
  const checks = verificationChecks(plan.args);
  const checkBoundary = JSON.parse(specs.at(-1).args[1]);
  requireValue(equal(checkBoundary, {
    command: checks.at(-1).command, repository: plan.repository, output: plan.boundaryPath,
  }) && equal(specs.map(({ name, program, args, success_condition }, i) => ({
    name, command: i === specs.length - 1 ? checkBoundary.command : [program, ...args],
    ...(success_condition ? { successCondition: [success_condition.program, ...success_condition.args] } : {}),
  })), checks), 'Review evidence does not match the retained check plan');
  const evidenceRoot = path.resolve(plan.repository, git(plan.repository, ['rev-parse', '--git-path', 'pi-conductor-evidence']));
  requireValue(path.dirname(plan.boundaryPath) === evidenceRoot &&
    /^[a-f0-9-]{36}\.boundary$/.test(path.basename(plan.boundaryPath)), 'Unsafe verification boundary path');
  const boundary = await lstat(plan.boundaryPath);
  requireValue(boundary.isFile() && !boundary.isSymbolicLink(), 'Unsafe verification boundary');
  const source = JSON.parse(await readFile(plan.boundaryPath, 'utf8'));
  requireValue(equal(source, await snapshot(plan.repository)) && source.head === plan.before.head &&
    !source.bookkeepingVisible, 'Source/index changed before review');
  const { stageResults } = await import('./pipeline.mjs');
  const runner = await stageResults(plan, stage.index);
  requireValue(runner.commands.length === stage.index && runner.commands.every(c => c.status === 'PASSED'),
    'Conductor verification prefix did not pass');
  const handoff = reviewHandoff(plan.workflow, reviewEvidence(plan, runner, source));
  requireValue(Buffer.byteLength(handoff.files[1][1], 'utf8') <= (plan.args.reviewContextMaxBytes ?? 200000),
    'Review criteria and authenticated check evidence exceed reviewContextMaxBytes; increase the allowance and continue');
  for (const [file, contents] of handoff.files)
    await writeFile(file, contents, { flag: 'wx', mode: 0o600 });
  return handoff;
}

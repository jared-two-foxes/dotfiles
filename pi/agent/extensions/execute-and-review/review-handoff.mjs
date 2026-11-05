import path from 'node:path';
import { lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import { isDeepStrictEqual as equal } from 'node:util';
import { readEvidence, snapshot } from '../../lib/delivery-state/evidence.mjs';
import { git } from '../../lib/delivery-state/git-tree.mjs';
import { authenticateWorkflow } from '../../lib/delivery-state/protocol.mjs';
import { verificationChecks } from '../../lib/delivery-state/verification.mjs';

import { reviewEvidence, reviewHandoff } from '../../lib/delivery-state/review-evidence.mjs';

function requireValue(ok, message) {
  if (!ok) throw new Error(message);
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

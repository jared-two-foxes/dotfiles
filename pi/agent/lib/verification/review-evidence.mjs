import path from 'node:path';
import { isDeepStrictEqual as equal } from 'node:util';
import { digest } from '../evidence/store.mjs';
import { verificationChecks } from './checks.mjs';
import { NO_DELTA_REVIEW_NOTE, taskHasNoDelta } from './no-delta.mjs';

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

export function reviewHandoff(workflow, evidence, { noDelta = false } = {}) {
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
    'assess any separate code findings against the source.' + (noDelta ? NO_DELTA_REVIEW_NOTE : '') +
    '\n' + JSON.stringify(evidence);
  const request = JSON.stringify({ ...workflow.inputs.review, requirements: requirementsPath });
  const files = [[requestPath, request], [requirementsPath, requirements]];
  const identity = { schema: evidence.schema, inputs: files.map(([file, contents]) => ({ file, sha256: digest(contents) })) };
  const args = original.args.map(arg => arg === path.join(root, 'review.json') ? requestPath : arg);
  return { args: [workflow.request.commands.at(-1).args[0], JSON.stringify({
    ...original, args, inputs: [...original.inputs, ...identity.inputs],
  })], files, identity };
}

// The one way to build the review handoff. The handoff step (what the reviewer is given) and the seal step
// (what the commit gate expects it was given) must derive identical contents, including the no-delta note,
// or the gate rejects the receipt as "Review did not receive the authenticated check evidence".
export function taskReviewHandoff(plan, runner, source) {
  return reviewHandoff(plan.workflow, reviewEvidence(plan, runner, source), {
    noDelta: taskHasNoDelta(plan.repository, plan.args.baseRef, source.tree),
  });
}

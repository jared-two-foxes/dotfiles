// Compose and decode one bounded execution/check/review pass.
import { mkdir, mkdtemp, writeFile, lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { conductorRequest, decodeRunner, toolOutput } from "../../lib/conductor/client.mjs";
import { executorExecutable, executorInput, executorStep } from "../../lib/executor/client.mjs";
import { deliveryReviewSettings, reviewExecutable, reviewRequest } from "../../lib/review/client.mjs";
import {
  guarded,
  reviewRequirements,
  deliveryReviewStep,
  reviewCondition,
  normalizeWorkflow,
} from "../../lib/verification/workflow.mjs";
const requireValue = (ok, message) => { if (!ok) throw new Error(message); };

export function validateWorkflowPreparation(args) {
  deliveryReviewSettings(args);
  for (const program of [executorExecutable(), reviewExecutable()])
    requireValue(
      typeof program === "string" && program.trim() && !program.includes("\0"),
      "Invalid tool executable",
    );
  executorInput(args.input);
}

export async function prepareWorkflow(repository, root, args, checks) {
  validateWorkflowPreparation(args);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const stat = await lstat(root);
  requireValue(
    stat.isDirectory() && !stat.isSymbolicLink(),
    "Unsafe Conductor runs directory",
  );
  const directory = await realpath(await mkdtemp(path.join(root, "attempt-")));
  const inputs = {
    execution: executorInput(args.input),
    requirements: reviewRequirements(args),
    review: reviewRequest(repository, args.baseRef, ":working", path.join(directory, "requirements.md")),
  };
  const execution = executorStep(path.join(directory, "executor.json"), inputs.execution);
  const review = deliveryReviewStep(directory, args, inputs);
  for (const [file, contents] of [...execution.files, ...review.files])
    await writeFile(file, contents, { mode: 0o600, flag: "wx" });

  const request = conductorRequest(repository, directory, [
    guarded("executor", execution.program, execution.args, execution.files),
    ...checks,
    { ...guarded("review", review.program, review.args, review.files), success_condition: reviewCondition },
  ]);
  return { request, inputs };
}

export async function decodeWorkflow(request, response, inputs) {
  const runner = decodeRunner(request, response);
  const toolOutputs = {};
  const execution = await toolOutput(request, runner, runner.commands[0]);
  if (execution !== undefined) toolOutputs.execution = execution;
  if (runner.commands.length === request.commands.length) {
    const review = await toolOutput(request, runner, runner.commands.at(-1));
    if (review !== undefined) toolOutputs.review = review;
  }
  return normalizeWorkflow(
    request,
    runner,
    toolOutputs,
    response.code,
    "conductor.result/v2",
    inputs.execution.operations.length,
  );
}

export function executionSummary(result) {
  if (result.actualResult)
    return { ...result, actualResult: executionSummary(result.actualResult) };
  const c = result.conductor;
  if (!c || c.schema !== "pi.conductor-result/v1") {
    if (!result.response) return result;
    const { request, response, ...summary } = result;
    return {
      ...summary,
      response: {
        code: response.code,
        stderr: response.stderr?.slice(0, 2000),
      },
      note: "Raw protocol and request retained in evidence; inspect before retrying.",
    };
  }
  return {
    ...result,
    conductor: {
      status: c.status,
      phase: c.phase,
      execution: c.execution,
      checks: c.checks.map((check) => ({
        name: check.name,
        exit_code: check.exit_code,
        stdout: check.stdout.slice(0, 2000),
        stderr: check.stderr.slice(0, 2000),
        stdout_path: check.stdout_path,
        stderr_path: check.stderr_path,
      })),
      review: c.review && {
        status: c.review.status,
        reason: c.review.reason,
        review_id: c.review.review_id,
        findings: c.review.findings
          .slice(0, 24)
          .map((f) => ({ ...f, message: f.message.slice(0, 1000) })),
        excerpted:
          c.review.findings.length > 24 ||
          c.review.findings.some((f) => f.message.length > 1000),
      },
      failed_command:
        c.runner.failed_command_index === undefined
          ? undefined
          : c.runner.commands.at(-1),
      error: c.error,
      output_directory: c.runner.output_directory,
      note: "Complete diagnostics and raw protocol are retained in the evidence/log files.",
    },
  };
}

// Reconstruct and authenticate immutable Executor/check/Review contracts.
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual as equal } from "node:util";
import { runnerExitCodes, validateRunner } from "../conductor/client.mjs";

import { executorInput, executorStep, validateExecutorResult } from "../executor/client.mjs";
import {
  deliveryReviewSettings,
  reviewRequest,
  reviewStep,
  validateReviewResult,
} from "../review/client.mjs";

const requireValue = (ok, message) => {
  if (!ok) throw new Error(message);
};

const digest = (value) => createHash("sha256").update(value).digest("hex");
const guard = fileURLToPath(new URL("./input-guard.mjs", import.meta.url));
export const reviewCondition = {
  program: process.execPath,
  args: [fileURLToPath(new URL("./review-condition.mjs", import.meta.url))],
};
// Historical paths are receipt identities only. New requests use the local helpers.
const reviewConditionByGuard = new Map([[guard, reviewCondition]]);
const legacyDirectory = new URL("../delivery-state/", import.meta.url);
reviewConditionByGuard.set(fileURLToPath(new URL("input-guard.mjs", legacyDirectory)), {
  program: process.execPath,
  args: [fileURLToPath(new URL("review-condition.mjs", legacyDirectory))],
});
for (const extension of ["execute-and-review", "conductor"]) {
  const directory = new URL(`../../extensions/${extension}/`, import.meta.url);
  reviewConditionByGuard.set(fileURLToPath(new URL("input-guard.mjs", directory)), {
    program: process.execPath,
    args: [fileURLToPath(new URL("review-condition.mjs", directory))],
  });
}

export function guarded(name, program, args, files, guardPath = guard) {
  return {
    name,
    program: process.execPath,
    args: [
      guardPath,
      JSON.stringify({
        program,
        args,
        inputs: files.map(([file, contents]) => ({
          file,
          sha256: digest(contents),
        })),
      }),
    ],
  };
}

export function reviewRequirements(args) {
  if (!args.verificationRepairReason) return args.requirements;
  return (
    args.requirements +
    "\n\nVerification command repair (does not change the criteria above):\n" +
    args.verificationRepairReason +
    "\nPrior attempt: " +
    args.previousAttempt +
    "\nCurrent verification plan: " +
    JSON.stringify(args.checks) +
    "\nReview that the repaired commands still exercise the approved coverage; a successful no-op is not verification."
  );
}

export function deliveryReviewStep(directory, args, inputs, program) {
  return reviewStep(path.join(directory, "review.json"), inputs.review, inputs.requirements,
    deliveryReviewSettings(args), { program, ledgerPath: path.join(directory, "review-ledger.jsonl") });
}

// Authenticate retained request contents without depending on mutable request/log
// files still being present. The receipt retains these inputs and parsed tool output.
export function authenticateWorkflow(workflow, request, args, repository) {
  requireValue(
    equal(workflow?.request, request) &&
      request.schema === "conductor.request/v2" &&
      request.working_directory === repository &&
      path.isAbsolute(request.output_directory),
    "Retained workflow mismatch",
  );
  const directory = request.output_directory;
  requireValue(
    equal(workflow.inputs.execution, executorInput(args.input)) &&
      workflow.inputs.requirements === reviewRequirements(args) &&
      equal(workflow.inputs.review, reviewRequest(
        repository, args.baseRef, ":working", path.join(directory, "requirements.md"),
      )),
    "Retained tool input mismatch",
  );
  const first = request.commands[0],
    last = request.commands.at(-1);
  const guardPath = first.args[0];
  const condition = reviewConditionByGuard.get(guardPath);
  requireValue(condition && last.args[0] === guardPath,
    "Retained Executor/Review invocation mismatch");
  const executorProgram = JSON.parse(first.args[1]).program;
  const reviewProgram = JSON.parse(last.args[1]).program;
  const execution = executorStep(path.join(directory, "executor.json"), workflow.inputs.execution, executorProgram);
  const review = deliveryReviewStep(directory, args, workflow.inputs, reviewProgram);
  const reviewInvocation = guarded("review", review.program, review.args, review.files, guardPath);
  requireValue(
    [executorProgram, reviewProgram].every(
      (program) =>
        typeof program === "string" &&
        program.trim() &&
        !program.includes("\0"),
    ) &&
      equal(first, guarded("executor", execution.program, execution.args, execution.files, guardPath)) &&
      (equal(last, {
        ...reviewInvocation,
        success_condition: condition,
      }) ||
        equal(last, reviewInvocation)), // Historical complete v2 receipts predate semantic Review conditions.
    "Retained Executor/Review invocation mismatch",
  );
  return request.commands.slice(1, -1);
}

// Pure reconstruction also authenticates the immutable normalized receipt later.
export function normalizeWorkflow(
  request,
  runner,
  toolOutputs,
  code,
  expectedSchema = "conductor.result/v2",
  expectedOperations,
) {
  validateRunner(request, runner, code, expectedSchema);
  requireValue(
    Number.isSafeInteger(expectedOperations) && expectedOperations >= 0,
    "Missing retained operation count",
  );
  if (expectedSchema === "pi.command-results/v1") {
    const conditionReceipts =
      runner.conditionReceipts ??
      (request.commands.every((command) => !command.success_condition)
        ? runner.commands.map(() => null)
        : null);
    requireValue(
      Array.isArray(runner.receipts) &&
        runner.receipts.length === runner.commands.length &&
        Array.isArray(conditionReceipts) &&
        conditionReceipts.length === runner.commands.length,
      "Missing command receipts",
    );
    for (const [index, record] of runner.commands.entries()) {
      const receipt = runner.receipts[index];
      if (!receipt) {
        requireValue(
          record.status === "BLOCKED",
          "Missing successful command receipt",
        );
        continue;
      }
      requireValue(
        receipt.schema === "pi.command-receipt/v1" &&
          receipt.index === index &&
          receipt.name === record.name &&
          receipt.program === record.program &&
          equal(receipt.args, record.args) &&
          receipt.exit_code === record.exit_code &&
          receipt.status ===
            (receipt.error || receipt.signal || receipt.exit_code === null
              ? "BLOCKED"
              : receipt.exit_code === 0
                ? "PASSED"
                : "FAILED") &&
          (record.status === "BLOCKED" ||
            record.condition ||
            receipt.status === record.status),
        "Command receipt mismatch",
      );
      const conditionReceipt = conditionReceipts[index];
      if (
        record.status === "PASSED" &&
        request.commands[index].success_condition
      )
        requireValue(
          conditionReceipt?.schema === "pi.condition-receipt/v1" &&
            conditionReceipt.index === index &&
            conditionReceipt.program === record.condition.program &&
            equal(conditionReceipt.args, record.condition.args) &&
            conditionReceipt.status === record.condition.status &&
            conditionReceipt.exit_code === record.condition.exit_code &&
            conditionReceipt.commandReceiptSha256 ===
              digest(JSON.stringify(receipt)),
          "Missing authenticated condition decision",
        );
      else if (!request.commands[index].success_condition)
        requireValue(conditionReceipt === null, "Unexpected condition receipt");
    }
  }
  const results = runner.commands;
  let execution = null,
    review = null,
    failure = null,
    status = "BLOCKED",
    phase = "execution";
  if (results[0]?.exit_code != null) {
    execution = JSON.parse(toolOutputs.execution);
    if (execution?.schema === "pi.tool-invocation-error/v1") {
      failure = execution;
      execution = null;
    } else {
      validateExecutorResult(execution, results[0].exit_code, expectedOperations);
    }
  }
  const checks = results.slice(1, request.commands.length - 1);
  if (results.length > 1) phase = "verification";
  if (results.length === request.commands.length) {
    phase = "review";
    const last = results.at(-1);
    // Validation/setup errors from Review are BLOCKED, not correction requests.
    if (last.exit_code != null && [0, 1, 3].includes(last.exit_code))
      review = validateReviewResult(JSON.parse(toolOutputs.review), last.exit_code);
    else if (toolOutputs.review) {
      const error = JSON.parse(toolOutputs.review);
      if (error.schema_version === "agent.error/v1")
        failure = { category: "review_engine", code: error.code };
      else if (error.schema === "pi.tool-invocation-error/v1")
        failure = {
          category:
            error.category === "invocation"
              ? "review_engine"
              : "evidence_integrity",
          code: error.code,
        };
    }
  }
  if (runner.status !== "BLOCKED") {
    if (phase === "review")
      status =
        review?.status === "APPROVED" && runner.status === "PASSED"
          ? "PASSED"
          : review?.status === "CHANGES_REQUESTED"
            ? "NEEDS_DESIGN"
            : "BLOCKED";
    else if (runner.status === "FAILED")
      status = results.at(-1)?.exit_code == null ? "BLOCKED" : "NEEDS_DESIGN";
  }
  return {
    schema: "pi.conductor-result/v1",
    status,
    phase,
    execution,
    checks,
    review,
    request,
    runner,
    toolOutputs,
    expectedOperations,
    ...(failure ? { failure } : {}),
    ...(runner.error ? { error: runner.error } : {}),
  };
}

export function authenticNormalized(conductor) {
  try {
    const schema = conductor.runner.schema;
    if (!["conductor.result/v2", "pi.command-results/v1"].includes(schema))
      return false;
    return equal(
      conductor,
      normalizeWorkflow(
        conductor.request,
        conductor.runner,
        conductor.toolOutputs,
        runnerExitCodes[conductor.runner.status],
        schema,
        conductor.expectedOperations,
      ),
    );
  } catch {
    return false;
  }
}

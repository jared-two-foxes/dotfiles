import { reusePlan } from "../../lib/verification/stage-reuse.mjs";
import {
  ledgerEventCount,
  readStageTimings,
  stopwatch,
  taskTimings,
} from "../../lib/verification/timings.mjs";
// One Conductor request, including the final Git commit command. Process receipts
// make the verified prefix available inside that list, before Conductor returns.
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  open,
  readFile,
  writeFile,
  readdir,
  lstat,
  realpath,
  rm,
} from "node:fs/promises";
import { isDeepStrictEqual as equal } from "node:util";
import { validateRunner, runConductor, toolOutput, DEFAULT_TIMEOUT_MS } from "../../lib/conductor/client.mjs";
import { normalizeWorkflow } from "../../lib/verification/workflow.mjs";
import { snapshot } from "../../lib/git/snapshot.mjs";
import { retainEvidence, readEvidence, taskEvidenceReferences } from "../../lib/evidence/store.mjs";
import { verifiedResult } from "../../lib/verification/result.mjs";
import { requireFeatureAuthorization } from "../scaffold/feature-authorization.mjs";
import { assertLatestAttempt } from "../../lib/verification/attempt-chain.mjs";
import { authenticateTaskEvidence } from "../../lib/verification/task-evidence.mjs";
import { git } from "../../lib/git/tree.mjs";
import { reviewEvidence, reviewHandoff, testCounts } from "../../lib/verification/review-evidence.mjs";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
const requireValue = (ok, message) => {
  if (!ok) throw new Error(message);
};
const result = (status, stage, fields = {}) => ({
  schema: "pi.execute-and-review.result/v1",
  status,
  stage,
  ...fields,
});
const exit = (status) => ({ PASSED: 0, FAILED: 1, BLOCKED: 2 })[status];
async function logDigest(file) {
  const info = await lstat(file);
  requireValue(
    info.isFile() && !info.isSymbolicLink(),
    "Unsafe retained log file",
  );
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function preview(file) {
  const info = await lstat(file);
  requireValue(
    info.isFile() && !info.isSymbolicLink(),
    "Unsafe retained log file",
  );
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(4 * 16385);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        length,
        buffer.length - length,
        length,
      );
      if (!bytesRead) break;
      length += bytesRead;
    }
    const chars = Array.from(buffer.subarray(0, length).toString("utf8"));
    let tail = chars.slice(16384).join("");
    if (info.size > length) {
      const { bytesRead } = await handle.read(
        buffer,
        0,
        buffer.length,
        Math.max(length, info.size - buffer.length),
      );
      tail += "\n" + buffer.subarray(0, bytesRead).toString("utf8");
    }
    return [chars.slice(0, 16384).join(""), chars.length > 16384, tail];
  } finally {
    await handle.close();
  }
}

async function logsFor(plan) {
  const root = plan.workflow.request.output_directory;
  const dirs = [];
  for (const name of await readdir(root)) {
    const file = path.join(root, name),
      info = await lstat(file);
    if (info.isDirectory() && !info.isSymbolicLink())
      dirs.push(await realpath(file));
  }
  requireValue(
    dirs.length === 1,
    "Missing or ambiguous Conductor log directory",
  );
  return dirs[0];
}

async function readStageReceipt(file) {
  const info = await lstat(file);
  requireValue(info.isFile() && !info.isSymbolicLink(), "Unsafe stage receipt");
  return readFile(file);
}

export async function stageResults(plan, attempted, rawRunner) {
  const commands = [],
    receipts = [],
    conditionReceipts = [],
    directory = await logsFor(plan);
  const specs = plan.workflow.request.commands;
  for (let index = 0; index < attempted; index++) {
    const spec = specs[index];
    const root = plan.workflow.request.output_directory;
    requireValue(
      plan.stages[index].receipt === path.join(root, `${index}.receipt.json`) &&
        (!spec.success_condition ||
          plan.stages[index].conditionReceipt ===
            path.join(root, `${index}.condition.json`)),
      "Stage receipt path is outside its assigned location",
    );
    let receipt = null,
      receiptBytes;
    try {
      receiptBytes = await readStageReceipt(plan.stages[index].receipt);
      receipt = JSON.parse(receiptBytes);
    } catch {}
    if (receipt)
      requireValue(
        receipt.schema === "pi.command-receipt/v1" &&
          receipt.index === index &&
          receipt.name === spec.name &&
          receipt.program === spec.program &&
          equal(receipt.args, spec.args) &&
          receipt.status ===
            (receipt.error ||
            receipt.signal ||
            !Number.isInteger(receipt.exit_code)
              ? "BLOCKED"
              : receipt.exit_code === 0
                ? "PASSED"
                : "FAILED"),
        "Stage receipt identity mismatch",
      );
    const stdout_path = path.join(
      directory,
      String(index).padStart(6, "0") + ".stdout",
    );
    const stderr_path = path.join(
      directory,
      String(index).padStart(6, "0") + ".stderr",
    );
    const [stdout, stdout_truncated, stdoutTail] = await preview(stdout_path);
    const [stderr, stderr_truncated, stderrTail] = await preview(stderr_path);
    let status = receipt?.status ?? "BLOCKED",
      condition,
      proof = null;
    if (spec.success_condition) {
      try {
        proof = JSON.parse(
          await readStageReceipt(plan.stages[index].conditionReceipt),
        );
      } catch {}
      if (proof)
        requireValue(
          receiptBytes &&
            proof.schema === "pi.condition-receipt/v1" &&
            proof.index === index &&
            proof.program === spec.success_condition.program &&
            equal(proof.args, spec.success_condition.args) &&
            proof.commandReceiptSha256 ===
              createHash("sha256").update(receiptBytes).digest("hex") &&
            proof.status ===
              (proof.error || proof.signal || proof.exit_code === null
                ? "BLOCKED"
                : proof.exit_code === 0
                  ? "PASSED"
                  : "FAILED"),
          "Condition receipt mismatch",
        );
      status = proof?.status ?? "BLOCKED";
      const out = path.join(
        directory,
        String(index).padStart(6, "0") + ".condition.stdout",
      );
      const err = path.join(
        directory,
        String(index).padStart(6, "0") + ".condition.stderr",
      );
      const [cstdout, ctruncated] = proof ? await preview(out) : ["", false];
      const [cstderr, cetruncated] = proof ? await preview(err) : ["", false];
      condition = {
        ...spec.success_condition,
        status,
        exit_code: proof?.exit_code ?? null,
        stdout: cstdout,
        stderr: cstderr,
        stdout_truncated: ctruncated,
        stderr_truncated: cetruncated,
        ...(proof ? { stdout_path: out, stderr_path: err } : {}),
        ...(proof?.error ? { error: proof.error } : {}),
      };
    }
    if (rawRunner)
      requireValue(
        rawRunner.commands[index].status === status ||
          (status === "BLOCKED" &&
            receipt?.status === "BLOCKED" &&
            rawRunner.commands[index].exit_code === 125),
        "Conductor and retained stage decision disagree",
      );
    commands.push({
      ...spec,
      index,
      status,
      exit_code: receipt?.exit_code ?? null,
      stdout,
      stderr,
      stdout_truncated,
      stderr_truncated,
      stdout_path,
      stderr_path,
      stdout_sha256: await logDigest(stdout_path),
      stderr_sha256: await logDigest(stderr_path),
      ...(index > 0 && index < specs.length - 1
        ? {
            testCounts: testCounts(stdout, stdoutTail, stderr, stderrTail),
          }
        : {}),
      ...(condition ? { condition } : {}),
      ...(receipt?.error ? { error: receipt.error } : {}),
    });
    receipts.push(receipt);
    conditionReceipts.push(proof);
    if (status !== "PASSED") break;
  }
  return { commands, receipts, conditionReceipts, directory };
}

export async function commandResults(plan, rawRunner) {
  const specs = plan.workflow.request.commands;
  const attempted = rawRunner
    ? Math.min(rawRunner.commands.length, specs.length)
    : specs.length;
  const { commands, receipts, conditionReceipts, directory } =
    await stageResults(plan, attempted, rawRunner);
  const status =
    commands.length === specs.length &&
    commands.every((c) => c.status === "PASSED")
      ? "PASSED"
      : (commands.at(-1)?.status ?? "BLOCKED");
  const observed = {
    schema: "pi.command-results/v1",
    status,
    commands,
    receipts,
    conditionReceipts,
    output_directory: directory,
    phase:
      status === "PASSED"
        ? "completed"
        : commands.length
          ? "commands"
          : "output",
    ...(status !== "PASSED" && commands.length
      ? {
          failed_command_index: commands.length - 1,
          error: "Verification command did not complete successfully",
        }
      : {}),
  };
  const toolOutputs = {};
  const execution = await toolOutput(
    plan.workflow.request,
    observed,
    commands[0],
  );
  if (execution !== undefined) toolOutputs.execution = execution;
  if (commands.length === specs.length) {
    const review = await toolOutput(
      plan.workflow.request,
      observed,
      commands.at(-1),
    );
    if (review !== undefined) toolOutputs.review = review;
  }
  return normalizeWorkflow(
    plan.workflow.request,
    observed,
    toolOutputs,
    exit(status),
    "pi.command-results/v1",
    plan.workflow.inputs.execution.operations.length,
  );
}

async function existingProof(plan) {
  const candidates = [];
  for (const reference of await taskEvidenceReferences(plan.repository)) {
    const record = await readEvidence(plan.repository, reference);
    if (
      record.startedReference === plan.startedReference &&
      record.result.status === "PASSED"
    )
      candidates.push({ reference, record });
  }
  requireValue(
    candidates.length <= 1,
    "Ambiguous verification receipts for delivery",
  );
  return candidates[0];
}

export async function sealVerification(plan) {
  const sealClock = stopwatch();
  await requireFeatureAuthorization(plan.args, { directory: plan.repository });
  const lockPath = path.join(
    plan.workflow.request.output_directory,
    "terminal.lock",
  );
  const lock = await open(lockPath, "wx", 0o600);
  try {
    const previous = await existingProof(plan);
    if (previous) {
      await authenticateTaskEvidence(
        plan.repository,
        previous.reference,
        plan.args.task,
      );
      return previous;
    }
    await assertLatestAttempt(
      plan.repository,
      plan.startedReference,
      plan.args.task,
      plan.attempt,
    );
    const conductor = await commandResults(plan);
    const verified = result(conductor.status, conductor.phase.toUpperCase(), {
      repository: plan.repository,
      conductor,
    });
    requireValue(
      verifiedResult(verified, plan.args),
      "Executor, checks and completed APPROVED review are required before commit",
    );
    const after = await snapshot(plan.repository);
    const reviewSnapshot = JSON.parse(
      await readFile(plan.boundaryPath, "utf8"),
    );
    requireValue(
      after.head === plan.before.head &&
        reviewSnapshot.head === after.head &&
        reviewSnapshot.tree === after.tree &&
        reviewSnapshot.digest === after.digest &&
        !reviewSnapshot.bookkeepingVisible,
      "Source/index changed during review; commit prohibited",
    );
    const expectedReview = reviewHandoff(
      plan.workflow,
      reviewEvidence(plan, conductor.runner, reviewSnapshot),
    );
    requireValue(
      equal(conductor.runner.receipts.at(-1).handoff, expectedReview.identity),
      "Review did not receive the authenticated check evidence",
    );
    // Retain the actual process-receipt prefix, not a fabricated completed
    // Conductor response. The enclosing runner is still executing its final command.
    const response = {
      code: 0,
      stdout: JSON.stringify(conductor.runner),
      stderr: "",
    };
    // Additive telemetry in its own top-level field; authenticators compare
    // named fields only, so older receipts without it remain valid.
    const outputDirectory = plan.workflow.request.output_directory;
    const timings = taskTimings({
      stages: await readStageTimings(
        outputDirectory,
        plan.workflow.request.commands,
        plan.workflow.request.commands.length,
      ),
      ledgerEvents: await ledgerEventCount(
        path.join(outputDirectory, "review-ledger.jsonl"),
      ),
      sealPrepMs: sealClock.elapsed(),
      attempt: plan.attempt,
    });
    const record = {
      repository: plan.repository,
      ...(plan.featureInstanceId ? { featureInstanceId: plan.featureInstanceId } : {}),
      timings,
      task: plan.args.task,
      attempt: plan.attempt,
      args: plan.args,
      before: plan.before,
      after,
      startedReference: plan.startedReference,
      workflow: plan.workflow,
      request: plan.workflow.request,
      response,
      reviewSnapshot,
      result: verified,
      producer: "pi.command-receipts/v2",
      deliveryRequest: plan.deliveryRequest,
    };
    const reference = await retainEvidence(plan.repository, record);
    await writeFile(
      path.join(plan.workflow.request.output_directory, "verified.json"),
      JSON.stringify({ reference }),
      { flag: "wx", mode: 0o600 },
    );
    return { reference, record };
  } finally {
    await lock.close();
    await rm(lockPath);
  }
}

export async function runPipeline(meta, feature, context, options = {}) {
  const instanceId = feature?.workflow?.instance_id;
  const root = meta.workflow.request.output_directory;
  const plan = {
    schema: "pi.delivery-plan/v1",
    ...meta,
    ...(instanceId ? { featureInstanceId: instanceId } : {}),
    feature: {
      branch: feature.branch,
      original_baseline: feature.original_baseline,
    },
    stages: [],
  };
  const commands = [];
  const planPath = path.join(root, "delivery.json");
  const reused = await reusePlan(meta.repository, meta.args, meta.before);
  for (const [index, command] of meta.workflow.request.commands.entries()) {
    const file = path.join(root, `${index}.stage.json`);
    const stage = {
      index,
      repository: meta.repository,
      command,
      ...(index === meta.workflow.request.commands.length - 1
        ? { reviewPlan: planPath }
        : index > 0
          ? { captureSource: true }
          : {}),
      ...(reused && index > 0 && index <= reused.count
        ? {
            reuse: {
              ...reused,
              index,
              boundaryPath: meta.boundaryPath,
              last: index === reused.count,
            },
          }
        : {}),
      receipt: path.join(root, `${index}.receipt.json`),
      ...(command.success_condition
        ? { conditionReceipt: path.join(root, `${index}.condition.json`) }
        : {}),
    };
    plan.stages.push(stage);
    await writeFile(file, JSON.stringify(stage), { mode: 0o600, flag: "wx" });
    commands.push({
      name: command.name,
      program: process.execPath,
      args: [
        fileURLToPath(new URL("./command-stage.mjs", import.meta.url)),
        file,
      ],
      ...(command.success_condition
        ? {
            success_condition: {
              program: process.execPath,
              args: [
                fileURLToPath(
                  new URL("./condition-stage.mjs", import.meta.url),
                ),
                file,
              ],
            },
          }
        : {}),
    });
  }
  commands.push({
    name: "git commit verified task",
    program: process.execPath,
    args: [
      fileURLToPath(new URL("./commit-task.mjs", import.meta.url)),
      planPath,
    ],
  });
  plan.deliveryRequest = { ...meta.workflow.request, commands };
  await writeFile(planPath, JSON.stringify(plan), { flag: "wx", mode: 0o600 });
  await writeFile(
    path.join(root, "request.json"),
    JSON.stringify(plan.deliveryRequest),
    { flag: "wx", mode: 0o600 },
  );
  let response, runner, problem, problemCode;
  try {
    response = await (
      options.invokeConductor ??
      ((body, timeoutMs) =>
        runConductor(body, {
          cwd: meta.repository,
          signal: context.abort,
          timeoutMs,
        }))
    )(
      JSON.stringify(plan.deliveryRequest),
      meta.args.workflowTimeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    await writeFile(
      path.join(root, "response.json"),
      JSON.stringify(response),
      { flag: "wx", mode: 0o600 },
    );
    runner = JSON.parse(response.stdout);
    validateRunner(plan.deliveryRequest, runner, response.code);
  } catch (error) {
    problem = error.message;
    problemCode = error.code;
  }
  // The in-list sealer may still be running after coordinator timeout. Never
  // write a competing terminal receipt while it owns this attempt's claim.
  const lockPath = path.join(root, "terminal.lock");
  let terminal;
  try {
    terminal = await open(lockPath, "wx", 0o600);
  } catch (error) {
    return result("BLOCKED", "EVIDENCE", {
      reason: "TERMINAL_RECEIPT_PENDING",
      message: error.message,
      deliveryDirectory: root,
      evidence: {
        reference: meta.startedReference,
        task: meta.args.task,
        attempt: meta.attempt,
      },
      recovery:
        "Inspect latest retained evidence and Git; a commit may still be running. Never replay the command list.",
    });
  }
  try {
    const sealed = await existingProof(plan);
    if (sealed) {
      await authenticateTaskEvidence(
        meta.repository,
        sealed.reference,
        meta.args.task,
      );
      const evidence = {
        reference: sealed.reference,
        task: meta.args.task,
        attempt: meta.attempt,
      };
      let checkpoint;
      try {
        const committed =
          runner?.commands.length === plan.deliveryRequest.commands.length
            ? JSON.parse(
                await toolOutput(
                  plan.deliveryRequest,
                  runner,
                  runner.commands.at(-1),
                ),
              )
            : null;
        requireValue(
          !problem && runner?.status === "PASSED",
          committed?.message ??
            problem ??
            runner?.error ??
            "Commit command failed",
        );
        checkpoint = committed.checkpoint;
        requireValue(
          committed.schema === "pi.task-finalization/v1" &&
            committed.ok &&
            checkpoint?.ok &&
            checkpoint.evidenceRef === sealed.reference &&
            checkpoint.tree === sealed.record.after.tree &&
            checkpoint.featureId === meta.args.task.featureId &&
            checkpoint.taskId === meta.args.task.taskId &&
            checkpoint.designRef === meta.args.task.designRef &&
            checkpoint.branch === feature.branch &&
            checkpoint.nextBaseRef === checkpoint.commit &&
            git(meta.repository, ["rev-parse", "HEAD"]) === checkpoint.commit &&
            git(meta.repository, ["rev-parse", "HEAD^{tree}"]) ===
              sealed.record.after.tree &&
            git(meta.repository, ["symbolic-ref", "--short", "HEAD"]) ===
              feature.branch &&
            (await snapshot(meta.repository)).clean,
          "Missing authenticated commit result",
        );
        return {
          ...sealed.record.result,
          stage: "COMMITTED",
          implementationStatus: "PASSED",
          evidence,
          checkpoint: { ...checkpoint, finalizationDirectory: root },
          nextBaseRef: checkpoint.nextBaseRef,
        };
      } catch (error) {
        return {
          ...sealed.record.result,
          status: "BLOCKED",
          stage: "CHECKPOINT",
          implementationStatus: "PASSED",
          evidence,
          reason: "FINALIZATION_BLOCKED",
          message: error.message,
          checkpoint: {
            ok: false,
            finalizationDirectory: root,
            stdout_path: runner?.commands.at(-1)?.stdout_path,
            stderr_path: runner?.commands.at(-1)?.stderr_path,
          },
          recovery:
            "Use checkpoint_verified_task with the retained receipt; never reapply operations.",
        };
      }
    }
    let outcome;
    try {
      requireValue(!problem && runner, problem ?? "Missing Conductor result");
      const conductor = await commandResults(plan, runner);
      outcome = result(conductor.status, conductor.phase.toUpperCase(), {
        repository: meta.repository,
        conductor,
      });
      // If the final command failed before sealing evidence, never infer approval
      // merely from a passed prefix. Its source/receipt gate must also succeed.
      if (outcome.status === "PASSED")
        outcome = result("BLOCKED", "EVIDENCE", {
          reason: "COMMIT_GATE_FAILED",
          message:
            runner.error ?? "Commit verification receipt was not retained",
          conductor,
        });
    } catch (error) {
      outcome = result("BLOCKED", "CONDUCTOR", {
        reason: ["WORKFLOW_TIMEOUT", "OUTPUT_LIMIT", "CANCELLED"].includes(
          problemCode,
        )
          ? "RESOURCE_PAUSED"
          : "PROTOCOL_MISMATCH",
        message: error.message,
      });
    }
    const after = await snapshot(meta.repository);
    if (after.head !== meta.before.head)
      outcome = result("BLOCKED", "EVIDENCE", {
        reason: "HEAD_CHANGED",
        actualResult: outcome,
      });
    const reference = await retainEvidence(meta.repository, {
      repository: meta.repository,
      ...(plan.featureInstanceId ? { featureInstanceId: plan.featureInstanceId } : {}),
      task: meta.args.task,
      args: meta.args,
      before: meta.before,
      after,
      attempt: meta.attempt,
      startedReference: meta.startedReference,
      request: meta.workflow.request,
      workflow: meta.workflow,
      deliveryRequest: plan.deliveryRequest,
      response: response ?? null,
      reviewSnapshot: await readFile(meta.boundaryPath, "utf8")
        .then(JSON.parse)
        .catch(() => null),
      result: outcome,
    });
    return {
      ...outcome,
      evidence: { reference, task: meta.args.task, attempt: meta.attempt },
    };
  } finally {
    await terminal.close();
    await rm(lockPath);
  }
}

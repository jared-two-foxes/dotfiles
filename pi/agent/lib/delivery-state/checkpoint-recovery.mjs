// Commit-only recovery for an already verified attempt.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { lstat, mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import {
  conductorRequest,
  decodeRunner,
  runConductor,
  toolOutput,
} from "../conductor/client.mjs";
import { git } from "./git-tree.mjs";
import { requireFeatureAuthorization } from "../scaffold/feature-authorization.mjs";
import { authenticateTaskEvidence } from "./task-evidence.mjs";
import { snapshot } from "./evidence.mjs";

const requireValue = (ok, message) => {
  if (!ok) throw new Error(message);
};
const sha = (value) => /^[a-f0-9]{40}$/.test(value ?? "");

export function validateCheckpoint(value) {
  requireValue(
    value &&
      typeof value.defaultBranch === "string" &&
      value.defaultBranch.trim() &&
      value.defaultBranch === value.defaultBranch.trim() &&
      !value.defaultBranch.includes("\0") &&
      Array.isArray(value.protectedBranches) &&
      value.protectedBranches.every(
        (x) =>
          typeof x === "string" &&
          x.trim() &&
          x === x.trim() &&
          !x.includes("\0"),
      ),
    "checkpoint requires the known defaultBranch and protectedBranches (or [])",
  );
}

export async function finalizeVerifiedTask(args, context = {}, options = {}) {
  let directory, request;
  try {
    validateCheckpoint(args);
    context.abort?.throwIfAborted();
    await requireFeatureAuthorization(args, context, options);
    const repository = path.resolve(
      git(context.directory, ["rev-parse", "--show-toplevel"]),
    );
    const record = await authenticateTaskEvidence(
      repository,
      args.evidenceRef,
      args.task,
    );
    const current = await snapshot(repository);
    // On recovery HEAD may already be the checkpoint. The checkpoint helper
    // authenticates that exact commit, its parent/tree/trailer and pending index.
    requireValue(
      current.head !== record.args.baseRef ||
        current.digest === record.after.digest,
      "Current source/index differs from the reviewed receipt",
    );
    const root = path.resolve(
      repository,
      git(repository, ["rev-parse", "--git-path", "pi-conductor-finalization"]),
    );
    await mkdir(root, { recursive: true, mode: 0o700 });
    const info = await lstat(root);
    requireValue(
      info.isDirectory() && !info.isSymbolicLink(),
      "Unsafe finalization directory",
    );
    directory = await realpath(await mkdtemp(path.join(root, "attempt-")));
    const input = path.join(directory, "checkpoint.json");
    await writeFile(input, JSON.stringify(args), { mode: 0o600, flag: "wx" });
    request = conductorRequest(repository, directory, [
      {
        name: "git commit verified task",
        program: process.execPath,
        args: [
          fileURLToPath(new URL("./commit-checkpoint.mjs", import.meta.url)),
          input,
        ],
      },
    ]);
    await writeFile(
      path.join(directory, "request.json"),
      JSON.stringify(request),
      { mode: 0o600, flag: "wx" },
    );
    const response = await (
      options.invokeFinalization ??
      ((body) =>
        runConductor(body, {
          cwd: repository,
          signal: context.abort,
          timeoutMs: options.timeoutMs,
        }))
    )(JSON.stringify(request));
    await writeFile(
      path.join(directory, "response.json"),
      JSON.stringify(response),
      { mode: 0o600, flag: "wx" },
    );
    const runner = decodeRunner(request, response);
    const text = await toolOutput(request, runner, runner.commands[0]);
    const result = text === undefined ? null : JSON.parse(text);
    requireValue(
      runner.status === "PASSED" &&
        result?.schema === "pi.task-finalization/v1" &&
        result.ok === true &&
        result.checkpoint?.ok === true &&
        result.checkpoint.evidenceRef === args.evidenceRef &&
        result.checkpoint.featureId === args.task.featureId &&
        result.checkpoint.taskId === args.task.taskId &&
        result.checkpoint.designRef === args.task.designRef &&
        result.checkpoint.tree === record.after.tree &&
        result.checkpoint.nextBaseRef === result.checkpoint.commit &&
        result.checkpoint.branch === args.branch &&
        result.checkpoint.featureBaseRef === args.featureBaseRef &&
        sha(result.checkpoint.commit) &&
        git(repository, ["rev-parse", "HEAD"]) === result.checkpoint.commit &&
        git(repository, ["rev-parse", "HEAD^{tree}"]) === record.after.tree &&
        (await snapshot(repository)).clean,
      result?.message ??
        runner.error ??
        "Commit command did not produce an authenticated checkpoint",
    );
    return { ok: true, ...result.checkpoint, finalizationDirectory: directory };
  } catch (error) {
    return {
      ok: false,
      reason: "FINALIZATION_BLOCKED",
      message: error.message,
      evidenceRef: args?.evidenceRef,
      ...(directory ? { finalizationDirectory: directory } : {}),
      recovery:
        "Keep the successful implementation receipt. Retry checkpoint_verified_task; never reapply operations to recover a failed commit.",
    };
  }
}

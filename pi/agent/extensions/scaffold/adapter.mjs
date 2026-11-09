// Scaffold CLI adapter owned by the Scaffold extension.
import { execFile } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { validateRequest, validateResponse } from "../../lib/scaffold/contracts.mjs";
export { OPERATIONS } from "../../lib/scaffold/contracts.mjs";

const text = x => typeof x === "string" && !!x.trim() && !x.includes("\0");
const object = x => x !== null && typeof x === "object" && !Array.isArray(x);
const requireValue = (ok, message) => { if (!ok) throw new Error(message); };
// checkpoint-record is validated by Scaffold itself (reference, chain, parent and tree).
const guardedActions = new Set(["design-reopen", "issue-resume"]);

/** @param {import("../../lib/scaffold/contracts.mjs").ScaffoldRequest} params */
export function buildCommand(params) {
  const { operation, feature_id, task_id, reason, payload } = validateRequest(params);
  const args = [operation, "--feature=" + feature_id];
  if (task_id !== undefined) args.push("--task=" + task_id);
  if (reason !== undefined) args.push("--reason=" + reason);
  if (payload !== undefined) args.push("--input", "-");
  return { args, input: payload === undefined ? "" : JSON.stringify(payload) };
}
// Process-lifetime Scaffold CLI usage, for delivery timing telemetry only.
const cliUsage = { calls: 0, totalMs: 0 };
export function scaffoldCliUsage() {
  return { calls: cliUsage.calls, totalMs: Math.round(cliUsage.totalMs * 1000) / 1000 };
}
export function scaffoldCliUsageSince(before) {
  const now = scaffoldCliUsage();
  return { calls: now.calls - before.calls, totalMs: Math.round((now.totalMs - before.totalMs) * 1000) / 1000 };
}

// Only Scaffold itself is accounted for; the Git repository probe that precedes
// every operation is not a Scaffold CLI call.
const isScaffold = program => path.basename(String(program)).replace(/\.(exe|cmd|bat)$/i, "") === "scaffold";

export function invoke(program, args, { cwd, signal, input = "" }) {
  const startedAt = performance.now();
  const counted = isScaffold(program);
  const record = () => {
    if (!counted) return;
    cliUsage.calls += 1;
    cliUsage.totalMs += performance.now() - startedAt;
  };
  return new Promise((resolve, reject) => {
    const child = execFile(
      program,
      args,
      {
        cwd,
        signal,
        shell: false,
        windowsHide: true,
        encoding: "utf8",
        timeout: 30000,
        maxBuffer: 8 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        record();
        if (error && (typeof error.code !== "number" || error.killed))
          reject(error);
        else resolve({ code: error?.code ?? 0, stdout, stderr });
      },
    );
    child.stdin.on("error", (error) => {
      if (error.code !== "EPIPE") {
        child.kill();
        reject(error);
      }
    });
    child.stdin.end(input);
  });
}


// Match Scaffold's task-only state paths and reject unsafe filesystem entries
// before invoking the CLI or reading persisted issue data.
export async function checkStatePaths(repository) {
  for (const [suffix, kind] of [
    [".scaffold", "directory"],
    [".scaffold/features", "directory"],
    [".scaffold/.tasks.lock", "file"],
  ]) {
    try {
      const stat = await lstat(path.join(repository, suffix));
      requireValue(
        !stat.isSymbolicLink(),
        "Scaffold state paths must not be symlinks: " + suffix,
      );
      requireValue(
        kind === "directory" ? stat.isDirectory() : stat.isFile(),
        "Scaffold state path must be a " +
          (kind === "directory" ? "directory: " : "regular file: ") + suffix,
      );
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

// Pi never reads Scaffold's files. State is read only through the Scaffold CLI.
const unknownFeature = (response) =>
  /Unknown feature/.test(String(response.scaffold_error?.error ?? "")) ||
  /Unknown feature/.test(String(response.stderr ?? ""));

/** The open feature instance with this id, or null when Scaffold has none. */
export async function scaffoldFeatureOrNull(repository, featureId, options = {}) {
  const response = await scaffoldTasks(
    { operation: "list", feature_id: featureId },
    { directory: repository },
    options,
  );
  if (response.ok) return response.data.feature;
  if (response.reason === "COMMAND_FAILED" && unknownFeature(response)) return null;
  throw new Error("Cannot inspect Scaffold: " + response.message);
}

/** Summaries of every open feature instance in the repository. */
export async function scaffoldFeatures(repository, options = {}) {
  await checkStatePaths(repository);
  const response = await (options.invokeScaffold ?? invoke)("scaffold", ["features"], {
    cwd: repository,
    input: "",
  });
  requireValue(response.code === 0, "Cannot list Scaffold features: " + String(response.stderr).slice(0, 500));
  const data = JSON.parse(response.stdout);
  requireValue(
    object(data) && data.schema_version === 3 && Array.isArray(data.features),
    "Unsupported Scaffold features response; Scaffold ledger schema 3 required",
  );
  return data.features;
}

async function loadIssueFeature(repository, featureId, designRef, options) {
  const response = await scaffoldTasks(
    { operation: "list", feature_id: featureId },
    { directory: repository },
    options,
  );
  requireValue(
    response.ok,
    "Cannot inspect issue workflow: " + response.message,
  );
  const feature = response.data.feature;
  requireValue(
    feature.workflow.kind === "recursive-issues/v1" &&
      feature.design_ref === designRef,
    "Issue workflow/design mismatch",
  );
  return feature;
}

export async function issueFeature(repository, binding, options = {}) {
  const stored = await scaffoldFeatureOrNull(repository, binding.featureId, options.scaffoldOptions);
  if (!stored?.workflow) return null;
  return loadIssueFeature(
    repository,
    binding.featureId,
    binding.designRef,
    options.scaffoldOptions,
  );
}

/** One explicit lifecycle operation in Pi's current Git repository. Never auto-retry. */
export async function scaffoldTasks(params, context = {}, options = {}) {
  let stage = "validation";
  const identity = {
    operation: params?.operation,
    feature_id: params?.feature_id,
    ...(params?.task_id !== undefined ? { task_id: params.task_id } : {}),
  };
  const failure = (reason, message, extra = {}) => ({
    ok: false,
    ...identity,
    reason,
    message,
    ...extra,
  });
  try {
    const command = buildCommand(params);
    stage = "repository";
    requireValue(text(context.directory), "Pi current directory is required");
    const cwd = await realpath(context.directory);
    const git = await invoke("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      signal: context.abort,
    });
    requireValue(
      git.code === 0,
      "Current directory must be inside the target Git repository",
    );
    const repository = await realpath(git.stdout.trim());
    await checkStatePaths(repository);
    if (guardedActions.has(params.operation)) {
      const storedFeature = await scaffoldFeatureOrNull(repository, params.feature_id, options);
      if (storedFeature?.workflow) {
        requireValue(
          storedFeature.workflow.kind === "recursive-issues/v1",
          "Issue workflow/design mismatch",
        );
        const feature = storedFeature;
        requireValue(
          typeof options.authorizeIssueMutation === "function",
          "Issue transition requires delivery authorization",
        );
        await options.authorizeIssueMutation(repository, feature, params);
      }
    }
    stage = "command";
    const response = await (options.invokeScaffold ?? invoke)(
      "scaffold",
      command.args,
      { cwd: repository, signal: context.abort, input: command.input },
    );
    if (response.code !== 0) {
      let error;
      try {
        error = JSON.parse(response.stderr);
      } catch {}
      return failure(
        "COMMAND_FAILED",
        "Scaffold command failed; inspect persisted state before retrying",
        {
          exit_code: response.code,
          stderr: response.stderr?.slice(0, 4000),
          ...(object(error) ? { scaffold_error: error } : {}),
        },
      );
    }
    stage = "response";
    let data;
    try {
      data = JSON.parse(response.stdout);
    } catch {
      return failure(
        "INVALID_JSON",
        "Scaffold returned invalid JSON; inspect persisted state before retrying",
      );
    }
    validateResponse(data, params);
    return { ok: true, ...identity, exit_code: 0, data };
  } catch (error) {
    return failure(
      stage === "validation"
        ? "INVALID_ARGUMENTS"
        : error.code === "ENOENT"
          ? "EXECUTABLE_NOT_FOUND"
          : stage === "response"
            ? "INVALID_RESPONSE"
            : "EXECUTION_ERROR",
      error.message +
        (stage === "command" || stage === "response"
          ? "; inspect persisted state before retrying"
          : ""),
    );
  }
}

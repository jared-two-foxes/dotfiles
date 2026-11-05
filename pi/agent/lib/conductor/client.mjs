// Internal client for the standalone Conductor v2 CLI.
import { spawn } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual as equal } from "node:util";

const MAX_LOG_BYTES = 16 * 1024 * 1024;
export const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
export const runnerExitCodes = { PASSED: 0, FAILED: 1, BLOCKED: 2 };

const requireValue = (ok, message) => {
  if (!ok) throw new Error(message);
};

export function conductorRequest(repository, directory, commands) {
  return {
    schema: "conductor.request/v2",
    working_directory: repository,
    output_directory: directory,
    commands,
  };
}

export function runConductor(requestJson, { cwd, signal, timeoutMs } = {}) {
  return invoke(process.env.CONDUCTOR_BIN ?? "conductor", ["run", "--request", "-"], {
    cwd,
    signal,
    input: requestJson,
    timeoutMs: timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });
}

// Delivery can retain the raw response before decoding or rejecting it.
export function decodeRunner(request, response) {
  const runner = JSON.parse(response.stdout);
  validateRunner(request, runner, response.code);
  return runner;
}

export async function invoke(
  program,
  args,
  { cwd, signal, input, timeoutMs = DEFAULT_TIMEOUT_MS } = {},
) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      cwd,
      detached: process.platform !== "win32",
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "",
      bytes = 0,
      failure,
      killTimer,
      termination;
    const stop = () => {
      if (!child.pid) return;
      if (process.platform === "win32") {
        termination ??= new Promise((resolve) => {
          const killer = spawn(
            "taskkill",
            ["/pid", String(child.pid), "/T", "/F"],
            { windowsHide: true },
          );
          killer.on("error", () => {
            child.kill("SIGKILL");
            resolve();
          });
          killer.on("close", resolve);
        });
      } else {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {}
        killTimer ??= setTimeout(() => {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {}
        }, 250);
      }
    };
    const abort = () => {
      failure ??= Object.assign(
        new Error(
          "CANCELLED: workflow interrupted; preserve source and receipts",
        ),
        { code: "CANCELLED" },
      );
      stop();
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(() => {
      failure = new Error(
        "Conductor exceeded the workflow deadline; the working tree may be partially modified",
      );
      failure.code = "WORKFLOW_TIMEOUT";
      stop();
    }, timeoutMs);
    const collect = (kind) => (chunk) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_LOG_BYTES) {
        failure = new Error(
          "Process output exceeded 16 MiB; the working tree may be partially modified",
        );
        failure.code = "OUTPUT_LIMIT";
        stop();
        return;
      }
      if (kind === "stdout") stdout += chunk.toString("utf8");
      else stderr += chunk.toString("utf8");
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", collect("stdout"));
    child.stderr.on("data", collect("stderr"));
    child.on("error", (error) => {
      failure ??= error;
    });
    child.on("close", async (code) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal?.removeEventListener("abort", abort);
      if (failure && child.pid && process.platform !== "win32") {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
      }
      if (termination) await termination;
      if (failure) reject(failure);
      else resolve({ code, stdout, stderr });
    });
    child.stdin.on("error", (error) => {
      // EPIPE is expected if the child rejects input early; the close handler
      // reports its actual status. Other errors are process failures.
      if (error.code !== "EPIPE") {
        failure = error;
        stop();
      }
    });
    child.stdin.end(input);
  });
}

export function validateRunner(
  request,
  runner,
  code,
  expectedSchema = "conductor.result/v2",
) {
  requireValue(
    runner?.schema === expectedSchema &&
      Object.hasOwn(runnerExitCodes, runner.status) &&
      runnerExitCodes[runner.status] === code &&
      Array.isArray(runner.commands),
    "Conductor schema/status/exit code mismatch",
  );
  const commands = runner.commands;
  requireValue(
    commands.length <= request.commands.length,
    "Unexpected Conductor commands",
  );
  for (const [index, result] of commands.entries()) {
    const expected = request.commands[index];
    requireValue(
      result.index === index &&
        result.name === expected.name &&
        result.program === expected.program &&
        equal(result.args, expected.args) &&
        Object.hasOwn(runnerExitCodes, result.status) &&
        typeof result.stdout === "string" &&
        typeof result.stderr === "string" &&
        typeof result.stdout_truncated === "boolean" &&
        typeof result.stderr_truncated === "boolean",
      "Conductor command identity/output mismatch",
    );
    if (expected.success_condition) {
      const c = result.condition;
      requireValue(
        (result.exit_code === null &&
          c === undefined &&
          result.status !== "PASSED") ||
          (c?.program === expected.success_condition.program &&
            equal(c.args, expected.success_condition.args) &&
            c.status === result.status &&
            typeof c.stdout === "string" &&
            typeof c.stderr === "string" &&
            typeof c.stdout_truncated === "boolean" &&
            typeof c.stderr_truncated === "boolean" &&
            (c.status === "PASSED"
              ? c.exit_code === 0
              : c.status === "FAILED"
                ? c.exit_code !== 0
                : true)),
        "Conductor condition result mismatch",
      );
    } else
      requireValue(
        result.condition === undefined,
        "Unexpected condition result",
      );
    if (index < commands.length - 1 || runner.status === "PASSED") {
      requireValue(
        result.status === "PASSED" &&
          (expected.success_condition || result.exit_code === 0) &&
          !result.error,
        "Conductor continued after a failed command",
      );
    }
  }
  if (runner.status === "PASSED") {
    requireValue(
      runner.phase === "completed" &&
        commands.length === request.commands.length &&
        runner.failed_command_index === undefined &&
        !runner.error,
      "Incomplete Conductor success",
    );
  } else if (commands.length) {
    const failed = commands.at(-1);
    requireValue(
      runner.phase === "commands" &&
        runner.failed_command_index === commands.length - 1 &&
        failed.status === runner.status &&
        (request.commands.at(commands.length - 1).success_condition ||
          runner.status !== "FAILED" ||
          failed.exit_code === null ||
          (Number.isInteger(failed.exit_code) && failed.exit_code !== 0)),
      "Conductor failure location/status mismatch",
    );
  } else {
    requireValue(
      runner.status === "BLOCKED" &&
        ["input", "output"].includes(runner.phase) &&
        runner.failed_command_index === undefined,
      "Missing Conductor failure record",
    );
  }
}

export async function toolOutput(request, runner, record) {
  if (!record || record.exit_code == null) return undefined;
  const file = record.stdout_path;
  requireValue(
    typeof file === "string" &&
      path.isAbsolute(file) &&
      typeof runner.output_directory === "string",
    "Invalid command log path",
  );
  const root = await realpath(request.output_directory),
    logs = await realpath(runner.output_directory);
  const relative = path.relative(root, logs);
  requireValue(
    relative && !relative.startsWith("..") && !path.isAbsolute(relative),
    "Command logs outside retained attempt",
  );
  const stat = await lstat(file);
  requireValue(
    stat.isFile() &&
      !stat.isSymbolicLink() &&
      (await realpath(file)) ===
        path.join(logs, String(record.index).padStart(6, "0") + ".stdout"),
    "Unsafe command log",
  );
  // Keep complete logs on disk when they exceed the structured output limit.
  requireValue(
    stat.size <= 16 * 1024 * 1024,
    "Structured tool output exceeds 16 MiB; inspect retained logs",
  );
  return new TextDecoder("utf-8", { fatal: true }).decode(await readFile(file));
}

// Runs the Scaffold CLI. Lives in lib so shared modules (evidence, verification) can reach Scaffold
// without importing an extension.
import { execFile } from "node:child_process";
import path from "node:path";
import { performance } from "node:perf_hooks";

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



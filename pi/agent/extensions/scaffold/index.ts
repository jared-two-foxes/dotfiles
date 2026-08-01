/**
 * Scaffold execution tool for pi.
 *
 * Registers a single tool:
 *
 *   scaffold_run -- runs scaffold push-ticket and next-step in a repo,
 *                   returning structured JSON instead of text-line parsing.
 */

import { execFile } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const ACCEPTANCE_CRITERIA_PATTERN = /## Acceptance Criteria[\s\S]*?- \[ \] /;
const MAX_STDOUT_LINES = 50;
const MAX_STDERR_LINES = 50;

function truncateLines(text: string, maxLines: number): string {
  if (!text) return "";
  const lines = text.split(/\r?\n/);
  if (lines.length <= maxLines) return lines.join("\n");
  return lines.slice(-maxLines).join("\n");
}

function readJsonIfPresent(repoPath: string, filename: string): unknown | null {
  const filePath = join(repoPath, filename);
  try {
    const content = readFileSync(filePath, "utf8");
    if (!content || !content.trim()) return null;
    return JSON.parse(content);
  } catch {
    return null;
  }
}

function readLastLog(repoPath: string): unknown | null {
  const filePath = join(repoPath, ".pipeline-log.jsonl");
  try {
    const content = readFileSync(filePath, "utf8");
    const lines = content.split(/\r?\n/).filter(Boolean);
    if (lines.length === 0) return null;
    return JSON.parse(lines[lines.length - 1]);
  } catch {
    return null;
  }
}

function runScaffold(
  repoPath: string,
  args: string[],
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve) => {
    const child = execFile(
      "scaffold",
      args,
      {
        cwd: repoPath,
        maxBuffer: 1024 * 1024 * 10,
        signal,
      },
      (error, stdout, stderr) => {
        const out = stdout?.toString() ?? "";
        const err = stderr?.toString() ?? "";
        if (error) {
          resolve({
            stdout: out,
            stderr: err,
            exitCode: typeof error.code === "number" ? error.code : null,
          });
          return;
        }
        resolve({ stdout: out, stderr: err, exitCode: 0 });
      },
    );

    child.on("error", () => {
      resolve({
        stdout: "",
        stderr: "Error: scaffold executable could not be launched.",
        exitCode: null,
      });
    });
  });
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "scaffold_run",
    label: "Scaffold Run",
    description:
      "Run scaffold against a repo spec and return structured state from " +
      "the criteria stack, pipeline log, and declined-criteria files.",
    parameters: Type.Object({
      repo_path: Type.String({
        description:
          "Absolute or relative path to the target repo. Must contain a " +
          ".dev-pipeline.toml if you want the git-workflow (branches/PRs) path; " +
          "otherwise defaults apply.",
      }),
      work_id: Type.String({
        description:
          "A Linear ticket id (e.g. SA-42) or a synthetic slug (e.g. " +
          "adhoc-cache-fix). scaffold re-fetches the ticket by id at its final " +
          "TICKET_VALIDATE step, so a real Linear ticket id is needed for a " +
          "clean 'done' result. A synthetic slug completes the red→green work " +
          "but the final validate re-fetch fails.",
      }),
      spec: Type.String({
        description:
          "Spec markdown: an H1 title + a '## Acceptance Criteria' section " +
          "with '- [ ] ...' checkbox bullets. Each criterion must be " +
          "independently testable — scaffold narrows each bullet into a red " +
          "test, implements to green, then validates. One spec per repo.",
      }),
    }),
    async execute(_toolCallId, params, signal) {
      const { repo_path, work_id, spec } = params;

      if (!spec || !spec.trim()) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  status: "failed",
                  stage: "pre",
                  exitCode: 2,
                  stack: null,
                  stackTopFrame: null,
                  lastLog: null,
                  declinedCriteria: null,
                  stdout: "",
                  stderr: "Error: spec must not be empty.",
                },
                null,
                2,
              ),
            },
          ],
          isError: true,
        };
      }

      if (!ACCEPTANCE_CRITERIA_PATTERN.test(spec)) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  status: "failed",
                  stage: "pre",
                  exitCode: 2,
                  stack: null,
                  stackTopFrame: null,
                  lastLog: null,
                  declinedCriteria: null,
                  stdout: "",
                  stderr:
                    "Error: spec must include a '## Acceptance Criteria' section with at least one '- [ ]' checkbox bullet.",
                },
                null,
                2,
              ),
            },
          ],
          isError: true,
        };
      }

      let repoStats;
      try {
        repoStats = statSync(repo_path);
      } catch {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  status: "failed",
                  stage: "pre",
                  exitCode: 2,
                  stack: null,
                  stackTopFrame: null,
                  lastLog: null,
                  declinedCriteria: null,
                  stdout: "",
                  stderr: `Error: repo path does not exist: ${repo_path}`,
                },
                null,
                2,
              ),
            },
          ],
          isError: true,
        };
      }

      if (!repoStats.isDirectory()) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  status: "failed",
                  stage: "pre",
                  exitCode: 2,
                  stack: null,
                  stackTopFrame: null,
                  lastLog: null,
                  declinedCriteria: null,
                  stdout: "",
                  stderr: `Error: repo path is not a directory: ${repo_path}`,
                },
                null,
                2,
              ),
            },
          ],
          isError: true,
        };
      }

      const tempDir = mkdtempSync(join(tmpdir(), "scaffold-spec-"));
      const specPath = join(tempDir, "spec.md");
      writeFileSync(specPath, spec, "utf-8");

      try {
        const whereCommand =
          process.platform === "win32" ? "where.exe" : "which";
        const scaffoldPath = await new Promise<string | null>((resolve) => {
          execFile(whereCommand, ["scaffold"], {}, (error, stdout) => {
            resolve(error ? null : stdout.trim());
          });
        });

        if (!scaffoldPath) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    status: "failed",
                    stage: "pre",
                    exitCode: 127,
                    stack: null,
                    stackTopFrame: null,
                    lastLog: null,
                    declinedCriteria: null,
                    stdout: "",
                    stderr: "Error: scaffold is not available on PATH.",
                  },
                  null,
                  2,
                ),
              },
            ],
            isError: true,
          };
        }

        const pushResult = await runScaffold(
          repo_path,
          ["push-ticket", work_id, "--ticket-file-in", specPath],
          signal,
        );
        if (pushResult.exitCode !== 0) {
          const stack = readJsonIfPresent(
            repo_path,
            ".criteria-stack.json",
          ) as Array<Record<string, unknown>> | null;
          const declinedCriteria = readJsonIfPresent(
            repo_path,
            ".declined-criteria.json",
          ) as Array<Record<string, unknown>> | null;
          const lastLog = readLastLog(repo_path);
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    status:
                      declinedCriteria &&
                      Array.isArray(declinedCriteria) &&
                      declinedCriteria.length > 0
                        ? "declined"
                        : "failed",
                    stage: "push",
                    exitCode: pushResult.exitCode,
                    stack,
                    stackTopFrame:
                      Array.isArray(stack) && stack.length > 0
                        ? stack[stack.length - 1]
                        : null,
                    lastLog,
                    declinedCriteria,
                    stdout: truncateLines(pushResult.stdout, MAX_STDOUT_LINES),
                    stderr: truncateLines(pushResult.stderr, MAX_STDERR_LINES),
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }

        const nextStepResult = await runScaffold(
          repo_path,
          ["next-step", "--continuous"],
          signal,
        );
        const stack = readJsonIfPresent(
          repo_path,
          ".criteria-stack.json",
        ) as Array<Record<string, unknown>> | null;
        const declinedCriteria = readJsonIfPresent(
          repo_path,
          ".declined-criteria.json",
        ) as Array<Record<string, unknown>> | null;
        const lastLog = readLastLog(repo_path);

        let status: "done" | "paused" | "failed" | "declined" = "done";
        if (nextStepResult.exitCode !== 0) {
          status = "failed";
        } else if (
          declinedCriteria &&
          Array.isArray(declinedCriteria) &&
          declinedCriteria.length > 0
        ) {
          status = "declined";
        } else if (Array.isArray(stack) && stack.length > 0) {
          status = "paused";
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  status,
                  stage: "next-step",
                  exitCode: nextStepResult.exitCode,
                  stack,
                  stackTopFrame:
                    Array.isArray(stack) && stack.length > 0
                      ? stack[stack.length - 1]
                      : null,
                  lastLog,
                  declinedCriteria,
                  stdout: truncateLines(
                    nextStepResult.stdout,
                    MAX_STDOUT_LINES,
                  ),
                  stderr: truncateLines(
                    nextStepResult.stderr,
                    MAX_STDERR_LINES,
                  ),
                },
                null,
                2,
              ),
            },
          ],
        };
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    },
  });
}

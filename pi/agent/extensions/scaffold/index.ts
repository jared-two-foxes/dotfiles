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
const PUSH_TICKET_PARAM_NAMES = [
  "strategy",
  "planning_strategy",
  "force",
  "prepend",
] as const;
const NEXT_STEP_PARAM_NAMES = [
  "max_attempts",
  "retry_policy",
  "accept_green",
  "accept_manual",
  "accept_no_test",
  "manual_test",
  "manual_test_refs",
  "skip_test",
  "skip_implementation",
  "next_step_strategy",
  "no_compile_tool",
  "no_reset_on_retry",
  "config",
] as const;

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

interface PushTicketParams {
  strategy?: "tdd" | "direct";
  planning_strategy?: "mechanical" | "agent";
  force?: boolean;
  prepend?: boolean;
}

interface NextStepParams {
  max_attempts?: number;
  retry_policy?: "fixed-budget" | "endless";
  accept_green?: boolean;
  accept_manual?: boolean;
  accept_no_test?: boolean;
  manual_test?: boolean;
  manual_test_refs?: string[];
  skip_test?: boolean;
  skip_implementation?: boolean;
  next_step_strategy?: "tdd" | "direct";
  no_compile_tool?: boolean;
  no_reset_on_retry?: boolean;
  config?: string;
}

function buildPushTicketFlags(params: PushTicketParams): string[] {
  const flags: string[] = [];
  if (params.strategy !== undefined) {
    flags.push("--strategy", params.strategy);
  }
  if (params.planning_strategy !== undefined) {
    flags.push("--planning-strategy", params.planning_strategy);
  }
  if (params.force) {
    flags.push("--force");
  }
  if (params.prepend) {
    flags.push("--prepend");
  }
  return flags;
}

function buildNextStepFlags(params: NextStepParams): string[] {
  const flags: string[] = [];
  if (params.max_attempts !== undefined) {
    flags.push("--max-attempts", String(params.max_attempts));
  }
  if (params.retry_policy !== undefined) {
    flags.push("--retry-policy", params.retry_policy);
  }
  if (params.accept_green) {
    flags.push("--accept-green");
  }
  if (params.accept_manual) {
    flags.push("--accept-manual");
  }
  if (params.accept_no_test) {
    flags.push("--accept-no-test");
  }
  if (params.manual_test) {
    flags.push("--manual-test");
  }
  if (params.manual_test_refs !== undefined && params.manual_test_refs.length > 0) {
    for (const ref of params.manual_test_refs) {
      flags.push("--manual-test-ref", ref);
    }
  }
  if (params.skip_test) {
    flags.push("--skip-test");
  }
  if (params.skip_implementation) {
    flags.push("--skip-implementation");
  }
  if (params.next_step_strategy !== undefined) {
    flags.push("--strategy", params.next_step_strategy);
  }
  if (params.no_compile_tool) {
    flags.push("--no-compile-tool");
  }
  if (params.no_reset_on_retry) {
    flags.push("--no-reset-on-retry");
  }
  if (params.config !== undefined) {
    flags.push("--config", params.config);
  }
  return flags;
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
      work_id: Type.Optional(
        Type.String({
          description:
            "A Linear ticket id (e.g. SA-42) or a synthetic slug (e.g. " +
            "adhoc-cache-fix). scaffold re-fetches the ticket by id at its final " +
            "TICKET_VALIDATE step, so a real Linear ticket id is needed for a " +
            "clean 'done' result. A synthetic slug completes the red→green work " +
            "but the final validate re-fetch fails. Required when mode is 'run'; " +
            "ignored for other modes.",
        }),
      ),
      spec: Type.Optional(
        Type.String({
          description:
            "Spec markdown: an H1 title + a '## Acceptance Criteria' section " +
            "with '- [ ] ...' checkbox bullets. Each criterion must be " +
            "independently testable — scaffold narrows each bullet into a red " +
            "test, implements to green, then validates. One spec per repo. " +
            "Required when mode is 'run'; ignored for other modes.",
        }),
      ),
      mode: Type.Optional(
        Type.Union(
          [
            Type.Literal("run"),
            Type.Literal("resume"),
            Type.Literal("status"),
            Type.Literal("feedback"),
          ],
          {
            description:
              "Execution mode. 'run' (default) pushes the spec ticket then runs " +
              "scaffold next-step --continuous. 'resume' skips push-ticket and " +
              "runs scaffold next-step --continuous directly. 'status' runs " +
              "scaffold status and returns the human-readable output in a " +
              "status_text field without running push-ticket, next-step, or any " +
              "AI steps. 'feedback' runs scaffold give-feedback with the provided " +
              "feedback_text (and optional feedback_target), then immediately runs " +
              "scaffold next-step --continuous with any provided next-step flags.",
          },
        ),
      ),
      model: Type.Optional(
        Type.String({
          description:
            "Model identifier to pass as --model to scaffold commands " +
            "(push-ticket and next-step). Omitted when not provided.",
        }),
      ),
      log_level: Type.Optional(
        Type.String({
          description:
            "Log level to pass as --log-level to scaffold commands " +
            "(push-ticket and next-step). Omitted when not provided.",
        }),
      ),
      // Push-ticket-specific parameters (used only when mode is "run")
      strategy: Type.Optional(
        Type.Union([Type.Literal("tdd"), Type.Literal("direct")], {
          description:
            "Implementation strategy to pass as --strategy to push-ticket. " +
            "Only used when mode is 'run'.",
        }),
      ),
      planning_strategy: Type.Optional(
        Type.Union([Type.Literal("mechanical"), Type.Literal("agent")], {
          description:
            "Planning strategy to pass as --planning-strategy to push-ticket. " +
            "Only used when mode is 'run'.",
        }),
      ),
      force: Type.Optional(
        Type.Boolean({
          description:
            "Pass --force to push-ticket. Only used when mode is 'run'.",
        }),
      ),
      prepend: Type.Optional(
        Type.Boolean({
          description:
            "Pass --prepend to push-ticket. Only used when mode is 'run'.",
        }),
      ),
      // Feedback-specific parameters (used only when mode is "feedback")
      feedback_text: Type.Optional(
        Type.String({
          description:
            "The feedback message to pass to scaffold give-feedback. " +
            "Required when mode is 'feedback'.",
        }),
      ),
      feedback_target: Type.Optional(
        Type.String({
          description:
            "The feedback target to pass as --target to scaffold " +
            "give-feedback. Defaults to 'auto' when mode is 'feedback' and " +
            "this parameter is not provided.",
        }),
      ),
      // Next-step-specific parameters (used when mode is "run", "resume", or "feedback")
      max_attempts: Type.Optional(
        Type.Number({
          description:
            "Pass --max-attempts to next-step. Used when mode is 'run', 'resume', or 'feedback'.",
        }),
      ),
      retry_policy: Type.Optional(
        Type.Union(
          [Type.Literal("fixed-budget"), Type.Literal("endless")],
          {
            description:
              "Pass --retry-policy to next-step. Used when mode is 'run', 'resume', or 'feedback'.",
          },
        ),
      ),
      accept_green: Type.Optional(
        Type.Boolean({
          description:
            "Pass --accept-green to next-step. Used when mode is 'run', 'resume', or 'feedback'.",
        }),
      ),
      accept_manual: Type.Optional(
        Type.Boolean({
          description:
            "Pass --accept-manual to next-step. Used when mode is 'run', 'resume', or 'feedback'.",
        }),
      ),
      accept_no_test: Type.Optional(
        Type.Boolean({
          description:
            "Pass --accept-no-test to next-step. Used when mode is 'run', 'resume', or 'feedback'.",
        }),
      ),
      manual_test: Type.Optional(
        Type.Boolean({
          description:
            "Pass --manual-test to next-step. Used when mode is 'run', 'resume', or 'feedback'.",
        }),
      ),
      manual_test_refs: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "Pass --manual-test-ref (one flag per entry) to next-step. Used when mode is 'run', 'resume', or 'feedback'.",
        }),
      ),
      skip_test: Type.Optional(
        Type.Boolean({
          description:
            "Pass --skip-test to next-step. Used when mode is 'run', 'resume', or 'feedback'.",
        }),
      ),
      skip_implementation: Type.Optional(
        Type.Boolean({
          description:
            "Pass --skip-implementation to next-step. Used when mode is 'run', 'resume', or 'feedback'.",
        }),
      ),
      next_step_strategy: Type.Optional(
        Type.Union([Type.Literal("tdd"), Type.Literal("direct")], {
          description:
            "Pass --strategy to next-step. Used when mode is 'run', 'resume', or 'feedback'.",
        }),
      ),
      no_compile_tool: Type.Optional(
        Type.Boolean({
          description:
            "Pass --no-compile-tool to next-step. Used when mode is 'run', 'resume', or 'feedback'.",
        }),
      ),
      no_reset_on_retry: Type.Optional(
        Type.Boolean({
          description:
            "Pass --no-reset-on-retry to next-step. Used when mode is 'run', 'resume', or 'feedback'.",
        }),
      ),
      config: Type.Optional(
        Type.String({
          description:
            "Pass --config to next-step. Used when mode is 'run', 'resume', or 'feedback'.",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal) {
      const { repo_path, work_id, spec, mode = "run" } = params;

      const pushTicketParamNames = PUSH_TICKET_PARAM_NAMES.filter(
        (name) => (params as Record<string, unknown>)[name] !== undefined,
      );
      if (mode !== "run" && pushTicketParamNames.length > 0) {
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
                  stderr: `Error: push-ticket-specific parameters (${pushTicketParamNames.join(", ")}) are only valid when mode is 'run'.`,
                },
                null,
                2,
              ),
            },
          ],
          isError: true,
        };
      }

      const nextStepParamNames = NEXT_STEP_PARAM_NAMES.filter(
        (name) => (params as Record<string, unknown>)[name] !== undefined,
      );
      if (mode === "status" && nextStepParamNames.length > 0) {
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
                  stderr: `Error: next-step-specific parameters (${nextStepParamNames.join(", ")}) are only valid when mode is 'run', 'resume', or 'feedback'.`,
                },
                null,
                2,
              ),
            },
          ],
          isError: true,
        };
      }

      // Cross-parameter validation
      if (mode === "feedback" && (!params.feedback_text || !params.feedback_text.trim())) {
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
                    "Error: feedback_text is required when mode is 'feedback'.",
                },
                null,
                2,
              ),
            },
          ],
          isError: true,
        };
      }

      // Spec validation is only required for "run" mode
      if (mode === "run") {
        if (!work_id || !work_id.trim()) {
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
                    stderr: "Error: work_id must be provided when mode is 'run'.",
                  },
                  null,
                  2,
                ),
              },
            ],
            isError: true,
          };
        }

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

      // --- status mode: run scaffold status and return output ---
      if (mode === "status") {
        const statusResult = await runScaffold(
          repo_path,
          ["status"],
          signal,
        );
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  status: statusResult.exitCode === 0 ? "ok" : "failed",
                  stage: "status",
                  exitCode: statusResult.exitCode,
                  status_text: statusResult.stdout,
                  stderr: truncateLines(statusResult.stderr, MAX_STDERR_LINES),
                },
                null,
                2,
              ),
            },
          ],
          isError: statusResult.exitCode !== 0,
        };
      }

      // --- feedback mode: run scaffold give-feedback then next-step ---
      if (mode === "feedback") {
        const feedbackTarget = params.feedback_target ?? "auto";
        const giveFeedbackArgs = [
          "give-feedback",
          params.feedback_text!,
          "--target",
          feedbackTarget,
        ];
        if (params.model) {
          giveFeedbackArgs.push("--model", params.model);
        }
        if (params.log_level) {
          giveFeedbackArgs.push("--log-level", params.log_level);
        }

        const feedbackResult = await runScaffold(
          repo_path,
          giveFeedbackArgs,
          signal,
        );

        if (feedbackResult.exitCode !== 0) {
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
                    status: "failed",
                    stage: "give-feedback",
                    exitCode: feedbackResult.exitCode,
                    stack,
                    stackTopFrame:
                      Array.isArray(stack) && stack.length > 0
                        ? stack[stack.length - 1]
                        : null,
                    lastLog,
                    declinedCriteria,
                    stdout: truncateLines(feedbackResult.stdout, MAX_STDOUT_LINES),
                    stderr: truncateLines(feedbackResult.stderr, MAX_STDERR_LINES),
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }

        // Fall through to next-step (shared with resume)
      }

      // --- run mode: push-ticket first ---
      if (mode === "run") {
        const tempDir = mkdtempSync(join(tmpdir(), "scaffold-spec-"));
        const specPath = join(tempDir, "spec.md");
        writeFileSync(specPath, spec!, "utf-8");

        try {
          const pushTicketExtraFlags = buildPushTicketFlags({
            strategy: params.strategy,
            planning_strategy: params.planning_strategy,
            force: params.force,
            prepend: params.prepend,
          });

          const pushTicketArgs = [
            "push-ticket",
            work_id,
            "--ticket-file-in",
            specPath,
            ...pushTicketExtraFlags,
          ];
          if (params.model) {
            pushTicketArgs.push("--model", params.model);
          }
          if (params.log_level) {
            pushTicketArgs.push("--log-level", params.log_level);
          }

          const pushResult = await runScaffold(
            repo_path,
            pushTicketArgs,
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
        } finally {
          rmSync(tempDir, { recursive: true, force: true });
        }
      }

      // --- next-step (run, resume, feedback modes) ---
      const nextStepExtraFlags = buildNextStepFlags({
        max_attempts: params.max_attempts,
        retry_policy: params.retry_policy,
        accept_green: params.accept_green,
        accept_manual: params.accept_manual,
        accept_no_test: params.accept_no_test,
        manual_test: params.manual_test,
        manual_test_refs: params.manual_test_refs,
        skip_test: params.skip_test,
        skip_implementation: params.skip_implementation,
        next_step_strategy: params.next_step_strategy,
        no_compile_tool: params.no_compile_tool,
        no_reset_on_retry: params.no_reset_on_retry,
        config: params.config,
      });

      const nextStepArgs = ["next-step", "--continuous", ...nextStepExtraFlags];
      if (params.model) {
        nextStepArgs.push("--model", params.model);
      }
      if (params.log_level) {
        nextStepArgs.push("--log-level", params.log_level);
      }

      const nextStepResult = await runScaffold(
        repo_path,
        nextStepArgs,
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
    },
  });
}

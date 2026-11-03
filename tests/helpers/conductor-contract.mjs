import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { successResponse, domainResponse } from "./conductor-v2.mjs";

async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "conductor-v2-contract-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.invalid");
  await writeFile(path.join(dir, "source.txt"), "before");
  git("add", ".");
  git("commit", "-qm", "baseline");
  const repository = path.resolve(git("rev-parse", "--show-toplevel"));
  return {
    dir: repository,
    git,
    args: {
      input: '{"operations":[]}',
      requirements: "Preserve full approved criteria",
      baseRef: git("rev-parse", "HEAD"),
      checks: [
        { name: "build", command: ["cargo", "check"] },
        { name: "test", command: ["cargo", "test", "--lib", "invoices::"] },
      ],
    },
  };
}

export function contract(label, executeAndReview, pi = false) {
  test(
    label + ": authors v2 command list and exact external tool request files",
    async (t) => {
      const f = await fixture(t);
      const result = await executeAndReview(
        f.args,
        { directory: f.dir },
        {
          invokeConductor: async (json) => {
            const request = JSON.parse(json);
            assert.equal(request.schema, "conductor.request/v2");
            assert.equal(request.working_directory, f.dir);
            assert.deepEqual(Object.keys(request).sort(), [
              "commands",
              "output_directory",
              "schema",
              "working_directory",
            ]);
            assert.deepEqual(
              request.commands.map((c) => c.name),
              ["executor", "build", "test", "review"],
            );
            assert.equal(request.commands[0].program, process.execPath);
            const executor = JSON.parse(request.commands[0].args[1]);
            assert.equal(executor.program, "executor");
            assert.equal(executor.args[0], "apply");
            assert.deepEqual(
              JSON.parse(await readFile(executor.args[1], "utf8")),
              JSON.parse(f.args.input),
            );
            assert.deepEqual(request.commands[2], {
              name: "test",
              program: "cargo",
              args: ["test", "--lib", "invoices::"],
            });
            const review = JSON.parse(request.commands.at(-1).args[1]);
            assert.equal(review.program, "review-cli");
            assert.match(
              request.commands.at(-1).success_condition.args[0],
              /review-condition\.mjs$/,
            );
            const reviewInput = JSON.parse(
              await readFile(review.args[2], "utf8"),
            );
            assert.deepEqual(
              {
                ...reviewInput,
                requirements: await readFile(reviewInput.requirements, "utf8"),
              },
              {
                schema: "review.request/v1",
                repository_path: f.dir,
                base_ref: f.args.baseRef,
                head_ref: ":working",
                requirements: f.args.requirements,
              },
            );
            assert.equal(
              review.args[review.args.indexOf("--wall-clock-budget-secs") + 1],
              "180",
            );
            assert.equal(
              review.args[review.args.indexOf("--max-turns") + 1],
              "20",
            );
            assert.equal(f.git("status", "--porcelain"), "");
            return successResponse(request);
          },
        },
      );
      assert.equal(result.status, "PASSED", JSON.stringify(result));
      assert.equal(result.conductor.schema, "pi.conductor-result/v1");
      assert.equal(result.conductor.runner.schema, "conductor.result/v2");
    },
  );

  if (!pi)
    test("OpenCode: build and test can carry caller-owned success conditions", async (t) => {
      const f = await fixture(t);
      const args = {
        ...f.args,
        buildSuccessCondition: ["rg", "-q", "build finished"],
        testSuccessCondition: ["rg", "-q", "test result: ok"],
      };
      const result = await executeAndReview(
        args,
        { directory: f.dir },
        {
          invokeConductor: async (json) => {
            const request = JSON.parse(json);
            assert.deepEqual(request.commands[1].success_condition, {
              program: "rg",
              args: ["-q", "build finished"],
            });
            assert.deepEqual(request.commands[2].success_condition, {
              program: "rg",
              args: ["-q", "test result: ok"],
            });
            return successResponse(request);
          },
        },
      );
      assert.equal(result.status, "PASSED", JSON.stringify(result));
    });

  if (!pi)
    test("OpenCode: structured Review condition runs from its independent installation", async (t) => {
      const f = await fixture(t);
      const file = path.join(f.dir, ".git", "review-output.json");
      const script = new URL(
        "../../opencode/scripts/review-condition.mjs",
        import.meta.url,
      );
      const { spawnSync } = await import("node:child_process");
      for (const [status, code] of [
        ["APPROVED", 0],
        ["CHANGES_REQUESTED", 1],
      ]) {
        await writeFile(
          file,
          JSON.stringify({
            schema: "review.result/v1",
            status,
            reason: "REVIEW_COMPLETED",
            review_id: "test",
            completed_at: "2026-11-01T00:00:00Z",
            findings:
              status === "APPROVED"
                ? []
                : [{ severity: "high", blocking: true, message: "fix" }],
          }),
        );
        const result = spawnSync(process.execPath, [fileURLToPath(script)], {
          cwd: f.dir,
          env: {
            ...process.env,
            CONDUCTOR_COMMAND_EXIT_CODE: String(code),
            CONDUCTOR_COMMAND_STDOUT_PATH: file,
          },
          encoding: "utf8",
        });
        assert.equal(
          result.status,
          status === "APPROVED" ? 0 : 1,
          result.stderr,
        );
      }
    });

  test(
    label +
      ": translates execution/check/review failures and indeterminate reviews without retry",
    async (t) => {
      const f = await fixture(t);
      for (const [domain, expected, stage] of [
        [
          {
            status: "NEEDS_DESIGN",
            phase: "execution",
            execution: { success: false },
          },
          "NEEDS_DESIGN",
          "EXECUTION",
        ],
        [
          {
            status: "NEEDS_DESIGN",
            phase: "verification",
            checks: [{ name: "build", exit_code: 7, stdout: "compile error" }],
          },
          "NEEDS_DESIGN",
          "VERIFICATION",
        ],
        [
          {
            status: "NEEDS_DESIGN",
            phase: "review",
            review: { status: "CHANGES_REQUESTED" },
          },
          "NEEDS_DESIGN",
          "REVIEW",
        ],
        [
          {
            status: "NEEDS_DESIGN",
            phase: "review",
            review: { status: "INDETERMINATE" },
          },
          "BLOCKED",
          "REVIEW",
        ],
        [{ status: "BLOCKED", phase: "review" }, "BLOCKED", "REVIEW"],
      ]) {
        let calls = 0;
        const result = await executeAndReview(
          f.args,
          { directory: f.dir },
          {
            invokeConductor: async (json) => {
              calls++;
              return domainResponse(JSON.parse(json), {
                code: domain.status === "BLOCKED" ? 3 : 2,
                stdout: JSON.stringify({
                  schema: "conductor.result/v1",
                  ...domain,
                }),
              });
            },
          },
        );
        assert.equal(result.status, expected, JSON.stringify(result));
        assert.equal(result.stage, stage);
        assert.equal(calls, 1);
      }
    },
  );

  test(
    label +
      ": parses full Review JSON beyond preview and preserves failure diagnostics paths",
    async (t) => {
      const f = await fixture(t);
      const message = "Detailed finding ".repeat(3000);
      const result = await executeAndReview(
        f.args,
        { directory: f.dir },
        {
          invokeConductor: async (json) =>
            domainResponse(JSON.parse(json), {
              code: 2,
              stdout: JSON.stringify({
                schema: "conductor.result/v1",
                status: "NEEDS_DESIGN",
                phase: "review",
                review: {
                  status: "CHANGES_REQUESTED",
                  findings: [{ severity: "high", blocking: true, message }],
                },
              }),
            }),
        },
      );
      assert.equal(result.status, "NEEDS_DESIGN", JSON.stringify(result));
      assert.equal(result.conductor.review.findings[0].message, message);
      assert.equal(
        result.conductor.runner.commands.at(-1).stdout_truncated,
        true,
      );
      assert.equal(
        JSON.parse(
          await readFile(
            result.conductor.runner.commands.at(-1).stdout_path,
            "utf8",
          ),
        ).findings[0].message,
        message,
      );
    },
  );

  test(
    label + ": contradictory successful Executor operation counts cannot pass",
    async (t) => {
      const f = await fixture(t);
      const result = await executeAndReview(
        f.args,
        { directory: f.dir },
        {
          invokeConductor: async (json) =>
            successResponse(JSON.parse(json), {
              execution: { success: true, operations_applied: 2 },
            }),
        },
      );
      assert.equal(result.status, "BLOCKED");
      assert.equal(result.reason, "PROTOCOL_MISMATCH");
    },
  );

  test(
    label +
      ": guarded Review rejects changed criteria and baseline before invocation",
    async (t) => {
      const f = await fixture(t);
      for (const changed of ["requirements", "review"]) {
        const result = await executeAndReview(
          f.args,
          { directory: f.dir },
          {
            invokeConductor: async (json) => {
              const request = JSON.parse(json);
              const guard = request.commands.at(-1);
              const { args } = JSON.parse(guard.args[1]);
              const reviewPath = args[args.indexOf("--request") + 1];
              const review = JSON.parse(await readFile(reviewPath, "utf8"));
              if (changed === "requirements")
                await writeFile(review.requirements, "weakened");
              else
                await writeFile(
                  reviewPath,
                  JSON.stringify({ ...review, base_ref: "wrong baseline" }),
                );
              const { spawnSync } = await import("node:child_process");
              const attempt = spawnSync(guard.program, guard.args, {
                cwd: f.dir,
                encoding: "utf8",
              });
              assert.equal(attempt.status, 125);
              assert.match(attempt.stderr, /Retained tool input changed/);
              return {
                code: 2,
                stdout: JSON.stringify({
                  schema: "conductor.result/v2",
                  status: "BLOCKED",
                  phase: "input",
                  commands: [],
                }),
                stderr: "",
              };
            },
          },
        );
        assert.equal(result.status, "BLOCKED");
      }
    },
  );

  test(
    label +
      ": fails closed on incomplete/altered generic responses and legacy runner output",
    async (t) => {
      const f = await fixture(t);
      for (const mutate of [
        (r, o) => {
          o.code = 2;
        },
        (r) => {
          r.schema = "conductor.result/v1";
        },
        (r) => {
          r.commands.pop();
        },
        (r) => {
          r.commands[1].name = "different";
        },
        (r) => {
          r.commands[1].args = [];
        },
        (r) => {
          r.commands[1].exit_code = 8;
        },
        (r) => {
          r.failed_command_index = 0;
        },
      ]) {
        const result = await executeAndReview(
          f.args,
          { directory: f.dir },
          {
            invokeConductor: async (json) => {
              const output = await successResponse(JSON.parse(json));
              const runner = JSON.parse(output.stdout);
              mutate(runner, output);
              output.stdout = JSON.stringify(runner);
              return output;
            },
          },
        );
        assert.equal(result.status, "BLOCKED");
        assert.equal(result.reason, "PROTOCOL_MISMATCH");
      }
    },
  );

  test(
    label + ": missing or truncated structured tool output can never approve",
    async (t) => {
      const f = await fixture(t);
      for (const mode of [
        "missing",
        "truncated",
        "invalid",
        "wrong-exit",
        "outside",
        "invalid-utf8",
      ]) {
        const result = await executeAndReview(
          f.args,
          { directory: f.dir },
          {
            invokeConductor: async (json) => {
              const output = await successResponse(JSON.parse(json));
              const runner = JSON.parse(output.stdout),
                review = runner.commands.at(-1);
              if (mode === "missing") await rm(review.stdout_path);
              if (mode === "truncated") {
                delete review.stdout_path;
                review.stdout_truncated = true;
              }
              if (mode === "invalid")
                await writeFile(review.stdout_path, "{invalid JSON");
              if (mode === "wrong-exit")
                await writeFile(
                  review.stdout_path,
                  JSON.stringify({
                    schema: "review.result/v1",
                    status: "INDETERMINATE",
                  }),
                );
              if (mode === "outside")
                review.stdout_path = path.join(f.dir, "source.txt");
              if (mode === "invalid-utf8")
                await writeFile(review.stdout_path, Buffer.from([0xff]));
              output.stdout = JSON.stringify(runner);
              return output;
            },
          },
        );
        assert.equal(result.status, "BLOCKED");
      }
    },
  );

  test(
    label +
      ": accepts complete untruncated inline v2 output when no log path is reported",
    async (t) => {
      const f = await fixture(t);
      const result = await executeAndReview(
        f.args,
        { directory: f.dir },
        {
          invokeConductor: async (json) => {
            const output = await successResponse(JSON.parse(json));
            const runner = JSON.parse(output.stdout);
            for (const c of runner.commands) {
              delete c.stdout_path;
              delete c.stderr_path;
            }
            delete runner.output_directory;
            output.stdout = JSON.stringify(runner);
            return output;
          },
        },
      );
      assert.equal(result.status, "PASSED", JSON.stringify(result));
    },
  );

  test(
    label +
      ": preflight rejects HEAD drift and invalid arguments without executing",
    async (t) => {
      const f = await fixture(t);
      for (const patch of [
        { input: "{broken" },
        { input: '{"patches":[]}' },
        { checks: [] },
        { baseRef: "HEAD" },
        { reviewModel: "invalid\0model" },
      ]) {
        const result = await executeAndReview(
          { ...f.args, ...patch },
          { directory: f.dir },
          {
            invokeConductor: () =>
              assert.fail("invalid request must not invoke"),
          },
        );
        assert.equal(result.status, "BLOCKED");
      }
      await writeFile(path.join(f.dir, "source.txt"), "new");
      f.git("add", ".");
      f.git("commit", "-qm", "next");
      const result = await executeAndReview(
        f.args,
        { directory: f.dir },
        { invokeConductor: () => assert.fail("HEAD drift") },
      );
      assert.equal(result.reason, "HEAD_CHANGED");
    },
  );

  if (pi)
    test("Pi: review flags and workflow deadline are independent, checks remain caller-selected", async (t) => {
      const f = await fixture(t);
      delete f.args.buildCommand;
      delete f.args.testCommand;
      Object.assign(f.args, {
        checks: [
          { name: "scoped tests", command: ["tool", "a b", "$(literal)", ";"] },
        ],
        workflowTimeoutMs: 5400000,
        reviewModel: "provider/model",
        reviewWallClockBudgetSecs: 240,
        reviewMaxTurns: 22,
        reviewMaxCostUsd: 2.5,
        reviewMaxToolCalls: 45,
        reviewMaxRepeatedActions: 4,
        reviewMaxCompletionAttempts: 2,
      });
      const result = await executeAndReview(
        f.args,
        { directory: f.dir },
        {
          invokeConductor: async (json, timeout) => {
            assert.equal(timeout, 5400000);
            const request = JSON.parse(json);
            assert.deepEqual(request.commands[1], {
              name: "scoped tests",
              program: "tool",
              args: ["a b", "$(literal)", ";"],
            });
            const review = JSON.parse(request.commands.at(-1).args[1]).args;
            for (const [flag, value] of [
              ["--model", "provider/model"],
              ["--wall-clock-budget-secs", "240"],
              ["--max-turns", "22"],
              ["--max-cost-usd", "2.5"],
              ["--max-tool-calls", "45"],
              ["--max-repeated-actions", "4"],
              ["--max-completion-attempts", "2"],
            ]) {
              assert.equal(review[review.indexOf(flag) + 1], value);
            }
            return successResponse(request);
          },
        },
      );
      assert.equal(result.status, "PASSED", JSON.stringify(result));
    });

  if (pi)
    test("Pi: invalid deadlines and runner interruption never retry or approve", async (t) => {
      const f = await fixture(t);
      for (const workflowTimeoutMs of [
        0,
        -1,
        1.5,
        2147483648,
        Number.MAX_SAFE_INTEGER + 1,
      ]) {
        const result = await executeAndReview(
          { ...f.args, workflowTimeoutMs },
          { directory: f.dir },
          {
            invokeConductor: () => assert.fail("invalid deadline"),
          },
        );
        assert.equal(result.status, "BLOCKED");
      }
      let calls = 0;
      const interrupted = await executeAndReview(
        { ...f.args, workflowTimeoutMs: 5 },
        { directory: f.dir },
        {
          invokeConductor: () => {
            calls++;
            throw new Error("Conductor exceeded the workflow deadline");
          },
        },
      );
      assert.equal(calls, 1);
      assert.equal(interrupted.status, "BLOCKED");
      assert.match(interrupted.message, /workflow deadline/);
      const previous = process.env.CONDUCTOR_BIN;
      process.env.CONDUCTOR_BIN = path.join(f.dir, "missing-conductor");
      try {
        const result = await executeAndReview(f.args, { directory: f.dir });
        assert.equal(result.status, "BLOCKED");
        assert.equal(result.reason, "EXECUTABLE_NOT_FOUND");
      } finally {
        if (previous === undefined) delete process.env.CONDUCTOR_BIN;
        else process.env.CONDUCTOR_BIN = previous;
      }
    });
}

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm, chmod } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { executeAndReview } from "../pi/agent/extensions/execute-and-review/adapter.mjs";
import { authenticateTaskEvidence } from "../pi/agent/lib/verification/task-evidence.mjs";
import { readEvidence, retainEvidence } from "../pi/agent/lib/evidence/store.mjs";
import { snapshot } from "../pi/agent/lib/git/snapshot.mjs";
import { executionSummary } from "../pi/agent/extensions/execute-and-review/workflow.mjs";

import { conductorFixture, executorFixture, reviewFixture } from "./helpers/conductor-executables.mjs";

test("standalone Conductor extension registers and runs a user command", {
  skip: process.platform === "win32" ? "Executable Node fixture uses a POSIX shebang" : false,
}, async t => {
  const { default: register } = await import("../pi/agent/extensions/conductor/index.ts");
  const directory = await mkdtemp(path.join(tmpdir(), "pi-standalone-conductor-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bin = path.join(directory, "conductor.mjs");
  await writeFile(bin, "#!/usr/bin/env node\n" + conductorFixture, { mode: 0o755 });
  const previous = process.env.CONDUCTOR_BIN;
  process.env.CONDUCTOR_BIN = bin;
  t.after(() => {
    if (previous === undefined) delete process.env.CONDUCTOR_BIN;
    else process.env.CONDUCTOR_BIN = previous;
  });
  await writeFile(path.join(directory, "request with spaces.json"), JSON.stringify({
    schema: "conductor.request/v2",
    working_directory: directory,
    output_directory: directory,
    commands: [{ name: "probe", program: process.execPath, args: ["-e", "console.log('probe')"] }],
  }));
  let handler;
  register({ registerCommand(name, command) {
    assert.equal(name, "conductor");
    handler = command.handler;
  } });
  const notifications = [];
  await handler("request with spaces.json", {
    cwd: directory, ui: { notify: (message, level) => notifications.push({ message, level }) },
  });
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].level, "info");
  const [status, logs] = notifications[0].message.split("\n");
  assert.equal(status, "Conductor PASSED (completed)");
  assert.equal(await readFile(path.join(logs, "000000.stdout"), "utf8"), "probe\n");
});

test(
  "real command sequence preserves full output, review boundary and immutable checkpoint evidence",
  {
    skip:
      process.platform === "win32"
        ? "Executable Node fixtures use POSIX shebangs; wire tests are portable"
        : false,
  },
  async (t) => {
    for (const [mode, expected] of [
      ["APPROVED", "PASSED"],
      ["CHANGES_REQUESTED", "NEEDS_DESIGN"],
      ["INDETERMINATE", "BLOCKED"],
      ["FAILED_CHECK", "NEEDS_DESIGN"],
    ]) {
      await t.test(mode, async (t) => {
        const directory = await mkdtemp(
          path.join(tmpdir(), "pi-v2-integration-"),
        );
        t.after(() => rm(directory, { recursive: true, force: true }));
        const git = (...args) =>
          execFileSync("git", args, {
            cwd: directory,
            encoding: "utf8",
          }).trim();
        git("init", "-q");
        git("config", "user.name", "Test");
        git("config", "user.email", "test@example.invalid");
        await writeFile(path.join(directory, "source.txt"), "before");
        git("add", ".");
        git("commit", "-qm", "baseline");
        const binaries = {};
        for (const [name, source] of [
          ["conductor", conductorFixture],
          ["executor", executorFixture],
          ["review", reviewFixture],
        ]) {
          const file = path.join(directory, ".git", name + ".mjs");
          await writeFile(file, "#!/usr/bin/env node\n" + source);
          await chmod(file, 0o755);
          binaries[name] = file;
        }
        const saved = Object.fromEntries(
          [
            "CONDUCTOR_BIN",
            "EXECUTOR_BIN",
            "REVIEW_CLI_BIN",
            "REVIEW_FIXTURE_STATUS",
          ].map((k) => [k, process.env[k]]),
        );
        Object.assign(process.env, {
          CONDUCTOR_BIN: process.env.CONDUCTOR_TEST_BIN ?? binaries.conductor,
          EXECUTOR_BIN: binaries.executor,
          REVIEW_CLI_BIN: binaries.review,
          REVIEW_FIXTURE_STATUS: mode,
        });
        t.after(() => {
          for (const [key, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
          }
        });
        const args = {
          task: { featureId: "F", taskId: "T", designRef: "approved" },
          baseRef: git("rev-parse", "HEAD"),
          requirements: "Complete immutable review requirements",
          input: JSON.stringify({
            operations: [
              {
                type: "edit_file",
                path: "source.txt",
                edits: [{ oldText: "before", newText: "after" }],
              },
            ],
          }),
          checks: [
            {
              name: "targeted regression",
              command: [
                process.execPath,
                "-e",
                'require("fs").appendFileSync(".git/trace", "check\\n"); console.log("3 tests passed");' +
                  (mode === "FAILED_CHECK" ? "process.exit(7);" : ""),
              ],
            },
          ],
        };
        const result = await executeAndReview(args, { directory });
        assert.equal(result.status, expected, JSON.stringify(result));
        assert.equal(
          await readFile(path.join(directory, "source.txt"), "utf8"),
          "after",
        );
        assert.equal(
          await readFile(path.join(directory, ".git/trace"), "utf8"),
          mode === "FAILED_CHECK"
            ? "executor\ncheck\n"
            : "executor\ncheck\nreview\n",
        );
        const record = await readEvidence(directory, result.evidence.reference);
        assert.equal(record.request.schema, "conductor.request/v2");
        assert.equal(record.workflow.inputs.requirements, args.requirements);
        if (mode !== "FAILED_CHECK") {
          const review = result.conductor.runner.commands.at(-1);
          assert.equal(review.stdout_truncated, true);
          assert.equal(
            JSON.parse(await readFile(review.stdout_path, "utf8")).padding
              .length,
            40000,
          );
        }
        if (mode === "APPROVED") {
          assert.equal(record.reviewSnapshot.tree, record.after.tree);
          assert.equal(
            executionSummary(result).conductor.toolOutputs,
            undefined,
          );
          const tampered = await retainEvidence(directory, {
            ...record,
            workflow: {
              ...record.workflow,
              inputs: { ...record.workflow.inputs, requirements: "weakened" },
            },
          });
          await assert.rejects(
            authenticateTaskEvidence(directory, tampered, args.task),
            /tool input mismatch/,
          );
          // Successful evidence is self-contained; log/request cleanup cannot forge
          // success, nor invalidate the immutable successful receipt after the fact.
          await rm(record.request.output_directory, { recursive: true });
          assert.equal(
            (
              await authenticateTaskEvidence(
                directory,
                result.evidence.reference,
                args.task,
              )
            ).attempt,
            1,
          );
        }
      });
    }
  },
);

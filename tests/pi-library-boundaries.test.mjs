import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { snapshot } from "../pi/agent/lib/git/snapshot.mjs";
import { prepareWorkflow } from "../pi/agent/extensions/execute-and-review/workflow.mjs";
import { authenticateWorkflow } from "../pi/agent/lib/verification/workflow.mjs";

const agent = fileURLToPath(new URL("../pi/agent/", import.meta.url));

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-library-boundary-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, {
    cwd: directory, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
  }).trimEnd();
  git("init", "-q", "-b", "feature/hash");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.invalid");
  git("config", "core.autocrlf", "false");
  await writeFile(path.join(directory, ".gitignore"), ".scaffold/\n");
  await writeFile(path.join(directory, "source.txt"), "one\n\n");
  git("add", ".");
  git("commit", "-qm", "baseline");
  return { directory, git };
}

test("shared contracts, receipt storage and verification load with every extension absent", async (t) => {
  const f = await fixture(t);
  const target = path.join(f.directory, "lib");
  await cp(path.join(agent, "lib"), target, { recursive: true });
  const load = name => import(pathToFileURL(path.join(target, name)).href);
  const contracts = await load("scaffold/contracts.mjs");
  const feature = await load("verification/feature.mjs");
  const evidence = await load("evidence/store.mjs");
  const task = await load("verification/task-evidence.mjs");
  const { obligationsVerified } = await load("verification/obligations.mjs");
  assert.equal(contracts.validateRequest({ operation: "list", feature_id: "F" }).operation, "list");
  assert.equal(Object.hasOwn(contracts, "scaffoldTasks"), false);
  assert.equal(Object.hasOwn(evidence, "verifiedResult"), false);
  assert.equal(Object.hasOwn(evidence, "snapshot"), false);
  assert.equal(typeof task.authenticateTaskEvidence, "function");
  const check = { name: "test", successPattern: "passed" };
  assert.equal(feature.meaningful(check, { exit_code: 0, stdout: "3 passed", stderr: "" }), true);
  assert.equal(feature.meaningful(check, { exit_code: 0, stdout: "0 passed", stderr: "" }), false);
  assert.equal(obligationsVerified({ deliveryContext: { obligations: [{ id: "failed-check", status: "open" }] } },
    { status: "APPROVED" }), false);
});

test("source fingerprints preserve historical receipt hashes including trailing diff bytes", async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.directory, "source.txt"), "two\n\n");
  f.git("add", "source.txt");
  await writeFile(path.join(f.directory, "source.txt"), "three\n\n");
  await writeFile(path.join(f.directory, "space name.txt"), "untracked\n\n");
  const state = await snapshot(f.directory);
  // Captured with the pre-refactor implementation from c7d32e2 for this exact source/index fixture.
  assert.equal(state.digest, "52b727b98f54c788e58f7579e5084d7d4aef6a0184985926b212856eb33fdbc5");
  assert.equal(state.tree, "6091cefe9269ae92993d4c501cc03da50d2c818f");
  assert.equal(state.clean, false);
});

test("workflow authentication requires current guards and rejects modified invocations", async (t) => {
  const f = await fixture(t);
  const args = { input: '{"operations":[]}', requirements: "Preserve approved scope",
    baseRef: f.git("rev-parse", "HEAD") };
  const checks = [{ name: "targeted", program: process.execPath, args: ["--version"] }];
  const workflow = await prepareWorkflow(f.directory, path.join(f.directory, ".git", "runs"), args, checks);
  assert.deepEqual(authenticateWorkflow(workflow, workflow.request, args, f.directory), checks);
  for (const location of ["lib/delivery-state", "extensions/conductor", "extensions/execute-and-review"]) {
    const retained = structuredClone(workflow);
    const first = retained.request.commands[0], last = retained.request.commands.at(-1);
    first.args[0] = last.args[0] = path.join(agent, location, "input-guard.mjs");
    last.success_condition.args[0] = path.join(agent, location, "review-condition.mjs");
    assert.throws(() => authenticateWorkflow(retained, retained.request, args, f.directory), /invocation mismatch/);
    last.args[1] = last.args[1].replace("--request", "--untrusted-request");
    assert.throws(() => authenticateWorkflow(retained, retained.request, args, f.directory),
      /Retained Executor\/Review invocation mismatch/);
  }
});

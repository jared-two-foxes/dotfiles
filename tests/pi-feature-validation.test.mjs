import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFile, readdir, mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { git } from "../pi/agent/lib/git/tree.mjs";
import { snapshot } from "../pi/agent/lib/git/snapshot.mjs";
import { invoke } from "../pi/agent/lib/scaffold/process.mjs";
import { readFeatureEvidence } from "../pi/agent/lib/evidence/store.mjs";
import { approveFeatureDirection } from "../pi/agent/extensions/scaffold/feature-authorization.mjs";
import { verifyHistory } from "../pi/agent/lib/verification/history.mjs";
import { spawnSync } from "node:child_process";
import { executeAndReview as executeTaskAttempt } from "./helpers/conductor-v2.mjs";
import { checkpointVerifiedTask } from "../pi/agent/extensions/checkpoint/scaffold.mjs";
import { scaffoldTasks } from "../pi/agent/extensions/scaffold/adapter.mjs";
import { designReference } from "../pi/agent/lib/scaffold/contracts.mjs";
import { authenticateIssueMutation } from "../pi/agent/lib/verification/issue-mutation.mjs";
import {
  validateFeature,
  inspectFeatureValidation,
} from "../pi/agent/extensions/feature-validation/feature.mjs";
import { readEvidence } from "../pi/agent/lib/evidence/store.mjs";
import { runCheck } from "../pi/agent/extensions/feature-validation/check-process.mjs";

import { approveGraph, requirementsFor } from "./helpers/issue-plan.mjs";
const fixtureScaffold = new Map();
async function executeAndReview(args, context, options) {
  const scaffoldOptions = fixtureScaffold.get(context.directory);
  const r = await scaffoldTasks(
    { operation: "list", feature_id: args.task.featureId },
    context,
    scaffoldOptions,
  );
  if (r.ok && !args.previousAttempt)
    args = {
      ...args,
      requirements: requirementsFor(
        r.data.feature.tasks[args.task.taskId],
        args.requirements,
      ),
    };
  return executeTaskAttempt(args, context, { ...options, scaffoldOptions });
}

const hasScaffold = spawnSync("scaffold", ["--help"], { encoding: "utf8" }).status === 0;
// A receipt or feature record is a ledger artifact: tamper with its stored bytes.
async function artifactPath(dir, reference) {
  const features = path.join(dir, ".scaffold", "features");
  const [instance] = await readdir(features);
  return path.join(features, instance, "artifacts", reference.split(":").at(-1));
}
const integration = { skip: !hasScaffold && "Real Scaffold (schema 3) is not on PATH" };
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "pi-feature-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = path.join(root, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  const g = (...args) => git(dir, args);
  g("config", "user.name", "Test");
  g("config", "user.email", "test@example.invalid");
  g("config", "core.autocrlf", "false");
  g("config", "core.excludesfile", "");
  await writeFile(path.join(dir, ".gitignore"), ".scaffold/\noutput/\n");
  await writeFile(path.join(dir, "source.txt"), "base\n");
  g("add", ".");
  g("commit", "-qm", "A");
  g("switch", "-qc", "feature/test");
  const base = g("rev-parse", "HEAD");
  const scaffoldOptions = {};
  fixtureScaffold.set(dir, scaffoldOptions);
  t.after(() => fixtureScaffold.delete(dir));
  const call = async (operation, extra = {}) => {
    if (operation === "start") {
      await approveGraph(call);
      const state = (await call("list")).feature;
      if (state.workflow.phase === "implement" && !state.direction) {
        const approved = await approveFeatureDirection({ featureId: "F5" }, { directory: dir }, { confirm: async () => true });
        assert.equal(approved.ok, true, JSON.stringify(approved));
      }
    }
    const response = await scaffoldTasks(
      { operation, feature_id: "F5", ...extra },
      { directory: dir },
      { ...scaffoldOptions, authorizeIssueMutation: authenticateIssueMutation },
    );
    assert.equal(response.ok, true, JSON.stringify(response));
    return response.data;
  };
  const context =
    "Approved feature: producer and consumer must interoperate. Preserve errors.\nOriginal baseline: " +
    base;
  const designRef = designReference(context);
  await call("init", {
    payload: {
      id: "F5",
      title: "Complete feature",
      objective: "Integrated behavior",
      context,
      design_ref: designRef,
      baseline: base,
      branch: "feature/test",
      acceptance_criteria: [
        "Producer and consumer interoperate",
        "Errors handled",
      ],
    },
  });
  const add = async (id, dependencies = [], parent) => {
    const feature = (await call("list")).feature;
    if (feature.workflow.phase === "implement")
      await call("design-reopen", {
        payload: { reason: "Plan additional fixture issues" },
      });
    return call(parent ? "decompose" : "add", {
      ...(parent ? { task_id: parent } : {}),
      payload: [
        {
          id,
          title: id,
          objective: id,
          acceptance_criteria: ["Verified " + id],
          dependencies,
        },
      ],
    });
  };
  async function finish(id, empty = false) {
    await call("start", { task_id: id });
    const args = {
      task: { featureId: "F5", taskId: id, designRef },
      baseRef: g("rev-parse", "HEAD"),
      input: '{"operations":[]}',
      requirements: "Only task " + id,
      checks: [
        { name: "build", command: ["build"] },
        { name: "test", command: ["test"] },
      ],
    };
    const attempt = await executeAndReview(
      args,
      { directory: dir },
      {
        invokeConductor: async (json) => {
          if (!empty) await writeFile(path.join(dir, id + ".txt"), id + "\n");
          const req = JSON.parse(json),
            boundary = JSON.parse(req.checks[1].args[1]);
          await writeFile(boundary.output, JSON.stringify(await snapshot(dir)));
          return {
            code: 0,
            stdout: JSON.stringify({
              schema: "fixture.delivery-outcome/v1",
              status: "PASSED",
              phase: "review",
              execution: { success: true },
              checks: ["build", "test"].map((name) => ({ name, exit_code: 0 })),
              review: { status: "APPROVED" },
            }),
          };
        },
      },
    );
    assert.equal(attempt.status, "PASSED", JSON.stringify(attempt));
    await call("complete", {
      task_id: id,
      payload: {
        feature_id: "F5",
        task_id: id,
        result: "PASSED",
        source: "conductor",
        reference: attempt.evidence.reference,
        summary: "Verified task",
      },
    });
    const checkpoint = await checkpointVerifiedTask(
      {
        task: args.task,
        evidenceRef: attempt.evidence.reference,
        featureBaseRef: base,
        branch: "feature/test",
        defaultBranch: "main",
        protectedBranches: [],
        authorizationMode: "manual",
      },
      { directory: dir },
      { scaffoldOptions, authorize: async () => true },
    );
    assert.equal(checkpoint.ok, true, JSON.stringify(checkpoint));
    return checkpoint;
  }
  const review = path.join(root, "review.cjs"),
    capture = path.join(root, "capture.json");
  async function reviewer(status = "APPROVED", mutation = "") {
    await writeFile(
      review,
      `const fs=require('node:fs');const args=process.argv.slice(2);
const req=JSON.parse(fs.readFileSync(args[args.indexOf('--request')+1],'utf8'));
fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify({req,requirements:fs.readFileSync(req.requirements,'utf8'),args}));
${mutation}
const requirements=fs.readFileSync(req.requirements,'utf8');
const obligations=[];
for(const line of requirements.split('\\n')) {
 if(line.startsWith('[{"id":')) for(const task of JSON.parse(line)) obligations.push(...(task.deliveryContext?.obligations??[]));
 if(line.startsWith('Persisted feature obligations: ')) obligations.push(...JSON.parse(line.slice('Persisted feature obligations: '.length)));
}
const obligation_assessments=[...new Set(obligations.map(o=>o.id))].map(id=>({obligation_id:id,disposition:'verified',evidence:'Independent fixture inspected the correction and integration regressions'}));
console.log(JSON.stringify({schema:'review.result/v1',obligation_assessments,status:${JSON.stringify(status)},reason:${JSON.stringify(status === "INDETERMINATE" ? "BUDGET_EXHAUSTED" : "REVIEW_COMPLETED")},review_id:'feature-review',completed_at:'2026-10-26T00:00:00Z',findings:${status === "CHANGES_REQUESTED" ? "[{blocking:true,severity:'high',message:'Consumer interface mismatches producer'}]" : "[]"}}));process.exit(${{ APPROVED: 0, CHANGES_REQUESTED: 1, INDETERMINATE: 3 }[status]});`,
    );
  }
  await reviewer();
  const options = {
    scaffoldOptions,
    authorize: async () => true,
    reviewOptions: { executable: process.execPath, prefixArgs: [review] },
  };
  const args = () => ({
    featureId: "F5",
    designRef,
    featureBaseRef: base,
    headRef: g("rev-parse", "HEAD"),
    branch: "feature/test",
    buildCommand: [process.execPath, "-e", 'console.log("project built")'],
    testCommand: [
      process.execPath,
      "-e",
      'console.log("12 integration tests passed")',
    ],
    testSuccessPattern: "12 integration tests passed",
    review: { maxTurns: 8, maxToolCalls: 30, wallClockBudgetSecs: 30 },
  });
  const validate = async (patch = {}, optionPatch = {}) => {
    const feature = (await call("list")).feature;
    if (
      feature.tasks.F5.status !== "completed" &&
      Object.values(feature.tasks)
        .filter((t) => t.id !== "F5")
        .every((t) => t.status === "completed")
    ) {
      try {
        verifyHistory(dir, feature, { head: g("rev-parse", "HEAD") });
        if ((await snapshot(dir)).clean) await finish("F5", true);
      } catch {} // Invalid checkpoints/source are tested by the real final gate below.
    }
    return validateFeature(
      { ...args(), ...patch },
      { directory: dir },
      { ...options, ...optionPatch },
    );
  };
  return {
    dir,
    g,
    base,
    add,
    finish,
    call,
    reviewer,
    options,
    args,
    validate,
    capture,
  };
}

test(
  "A → B → C → D feature review, failed integration, corrective E and revalidation A → E",
  integration,
  async (t) => {
    const f = await fixture(t);
    await f.add("parent");
    await f.add("one", [], "parent");
    await f.add("two", ["one"], "parent");
    await f.finish("one");
    await f.finish("two");
    const d = await f.finish("parent", true);
    assert.equal(f.g("rev-list", "--count", f.base + "..HEAD"), "3");
    await f.reviewer("CHANGES_REQUESTED");
    const failed = await f.validate();
    assert.equal(failed.status, "NEEDS_DESIGN", JSON.stringify(failed));
    assert.equal((await f.call("list")).feature.validation.status, "failed");
    let capture = JSON.parse(await readFile(f.capture, "utf8"));
    assert.equal(capture.req.base_ref, f.base);
    assert.equal(capture.req.head_ref, f.g("rev-parse", "HEAD"));
    assert.match(
      capture.requirements,
      /Approved feature: producer and consumer/,
    );
    assert.match(capture.requirements, /Producer and consumer interoperate/);
    assert.match(capture.requirements, /12 integration tests passed/);
    assert.match(capture.requirements, /cross-task integration/);
    assert.equal(
      capture.args[capture.args.indexOf("--max-tool-calls") + 1],
      "30",
    );
    await f.add("fix", ["parent"]);
    assert.equal((await f.validate()).status, "BLOCKED");
    const e = await f.finish("fix");
    await f.reviewer();
    const passed = await f.validate();
    assert.equal(passed.status, "PASSED", JSON.stringify(passed));
    assert.equal(passed.binding.head, e.commit);
    assert.equal(passed.binding.baseline, f.base);
    // Telemetry is retained beside, never inside, the authenticated fields.
    const timed = await readFeatureEvidence(f.dir, passed.evidenceRef);
    assert.equal(timed.timings.kind, "feature");
    assert.ok(timed.timings.checks.length >= 1);
    assert.ok(timed.timings.review_ms >= 0);
    // initial + post-authorization + after the check(s) + after review + before retention
    assert.ok(timed.timings.precondition_checks >= 5);
    // The first and last derivations before retention always recompute in full; the
    // ones between reuse the immutable authentication while nothing it reads changed.
    assert.ok(timed.timings.precondition_cache.fresh >= 2);
    assert.ok(timed.timings.precondition_cache.hits >= 1);
    capture = JSON.parse(await readFile(f.capture, "utf8"));
    assert.equal(capture.req.head_ref, e.commit);
    const feature = (await f.call("list")).feature;
    assert.equal(feature.validation.status, "verified");
    assert.deepEqual(
      feature.validation.history
        .filter((h) => h.event === "finished")
        .map((h) => h.result.status),
      ["NEEDS_DESIGN", "PASSED"],
    );
    const retry = await f.validate({ resumeEvidenceRef: passed.evidenceRef });
    assert.equal(retry.status, "PASSED", JSON.stringify(retry));
    assert.equal(retry.recovered, true);
    assert.deepEqual(
      (await f.call("list")).feature.validation.history,
      feature.validation.history,
    );
  },
);

test(
  "task evidence changed during validation is still caught despite cached authentication",
  integration,
  async (t) => {
    const f = await fixture(t);
    await f.add("one");
    const checkpoint = await f.finish("one");
    // The receipt the task's checkpoint is authenticated against (the evidence
    // directory also holds intent and other records that validation never reads).
    const receipt = await artifactPath(f.dir, checkpoint.evidenceRef);
    const interrupted = await f.validate(
      {},
      {
        interrupt: async (stage) => {
          if (stage !== "beforeReview") return;
          // Earlier derivations have cached this authentication; now corrupt the
          // receipt it covers. The changed evidence must not be trusted.
          await appendFile(receipt, " ");
        },
      },
    );
    assert.equal(interrupted.status, "BLOCKED", JSON.stringify(interrupted));
    assert.match(interrupted.message, /digest/i, JSON.stringify(interrupted));
    assert.notEqual(
      (await f.call("list")).feature.validation.status,
      "verified",
    );
    // The cache really was in use before the corruption was detected.
    const diagnostic = await readFeatureEvidence(
      f.dir,
      interrupted.diagnosticEvidenceRef,
    );
    assert.ok(diagnostic.timings.precondition_cache.hits >= 1);
  },
);

test(
  "unfinished, blocked, missing-checkpoint, unrelated-commit and changed-design features fail closed",
  integration,
  async (t) => {
    for (const variant of [
      "pending",
      "blocked",
      "missingCheckpoint",
      "unrelated",
      "design",
    ]) {
      const f = await fixture(t);
      await f.add("one");
      if (variant === "blocked")
        await f.call("block", { task_id: "one", reason: "Needs architecture" });
      if (["unrelated", "missingCheckpoint", "design"].includes(variant))
        await f.finish("one");
      if (variant === "unrelated")
        f.g("commit", "--allow-empty", "-qm", "Unrelated commit");
      if (variant === "missingCheckpoint") f.g("reset", "--hard", f.base);
      const r = await f.validate(
        variant === "design" ? { designRef: "wrong" } : {},
      );
      assert.equal(r.status, "BLOCKED", variant + JSON.stringify(r));
      assert.equal(
        ((await f.call("list")).feature.validation?.history ?? []).length,
        0,
      );
    }
  },
);

test(
  "lost or modified task evidence prevents feature validation",
  integration,
  async (t) => {
    for (const variant of ["lost", "modified"]) {
      const f = await fixture(t);
      await f.add("one");
      const c = await f.finish("one");
      const file = await artifactPath(f.dir, c.evidenceRef);
      if (variant === "lost") await rm(file);
      else await writeFile(file, "{}");
      assert.equal((await f.validate()).status, "BLOCKED");
    }
  },
);

test(
  "full checks: nonzero, missing tool, absent meaningful tests, integration failure and indeterminate review",
  integration,
  async (t) => {
    const f = await fixture(t);
    await f.add("one");
    await f.finish("one");
    for (const [patch, expected] of [
      [
        {
          testCommand: [
            process.execPath,
            "-e",
            'console.error("integration defect");process.exit(7)',
          ],
        },
        "NEEDS_DESIGN",
      ],
      [
        { buildCommand: ["definitely-missing-verification-program"] },
        "BLOCKED",
      ],
      [
        { testCommand: [process.execPath, "-e", 'console.log("0 tests ran")'] },
        "BLOCKED",
      ],
      [
        {
          integrationChecks: [
            {
              name: "smoke",
              command: [process.execPath, "-e", "process.exit(5)"],
              successPattern: "smoke passed",
            },
          ],
        },
        "NEEDS_DESIGN",
      ],
    ]) {
      const r = await f.validate(patch);
      assert.equal(r.status, expected, JSON.stringify(r));
      assert.notEqual(
        (await f.call("list")).feature.validation.status,
        "verified",
      );
      assert.ok(r.evidenceRef);
    }
    await f.reviewer("INDETERMINATE");
    assert.equal((await f.validate()).status, "BLOCKED");
  },
);

test(
  "source mutations during checks/review, branch changes and stale successful evidence cannot complete",
  integration,
  async (t) => {
    for (const variant of ["check", "review", "head", "staged", "branch"]) {
      const f = await fixture(t);
      await f.add("one");
      await f.finish("one");
      if (variant === "check") {
        const r = await f.validate({
          testCommand: [
            process.execPath,
            "-e",
            'require("fs").writeFileSync("source.txt","changed");console.log("12 integration tests passed")',
          ],
        });
        assert.equal(r.status, "BLOCKED");
        assert.match(r.message, /clean|changed/);
      } else if (variant === "review") {
        await f.reviewer(
          "APPROVED",
          'fs.writeFileSync(require("node:path").join(req.repository_path,"source.txt"),"changed");',
        );
        assert.equal((await f.validate()).status, "BLOCKED");
      } else {
        const r = await f.validate();
        assert.equal(r.status, "PASSED", JSON.stringify(r));
        if (variant === "head")
          f.g("commit", "--allow-empty", "-qm", "changed HEAD");
        if (variant === "staged") {
          await writeFile(path.join(f.dir, "source.txt"), "changed");
          f.g("add", ".");
        }
        if (variant === "branch") f.g("switch", "-qc", "other-feature");
        assert.equal(
          (await f.validate({ resumeEvidenceRef: r.evidenceRef })).status,
          "BLOCKED",
        );
        const inspected = await inspectFeatureValidation(
          { reference: r.evidenceRef },
          { directory: f.dir },
          f.options,
        );
        assert.equal(inspected.ok, true);
        assert.equal(inspected.results[0].applicable, false);
        assert.equal(
          (await readFeatureEvidence(f.dir, r.evidenceRef)).result.status,
          "PASSED",
        );
      }
    }
  },
);

test(
  "interruption before/during verification never infers success; retained complete results reconcile once",
  integration,
  async (t) => {
    for (const point of [
      "beforeChecks",
      "beforeReview",
      "beforeRetention",
      "afterRetention",
      "afterCompletion",
    ]) {
      const f = await fixture(t);
      await f.add("one");
      await f.finish("one");
      const interrupted = await f.validate(
        {},
        {
          interrupt: async (stage) => {
            if (stage === point) throw Error("Interrupted at " + point);
          },
        },
      );
      assert.equal(interrupted.status, "BLOCKED");
      if (["afterRetention", "afterCompletion"].includes(point)) {
        const recovered = await f.validate({
          resumeEvidenceRef: interrupted.evidenceRef,
        });
        assert.equal(recovered.status, "PASSED", JSON.stringify(recovered));
        const before = (await f.call("list")).feature.validation.history;
        assert.equal(
          (await f.validate({ resumeEvidenceRef: interrupted.evidenceRef }))
            .status,
          "PASSED",
        );
        assert.deepEqual(
          (await f.call("list")).feature.validation.history,
          before,
        );
      } else {
        assert.notEqual(
          (await f.call("list")).feature.validation.status,
          "verified",
        );
        // Interrupted runs keep the timing evidence gathered so far: at least the
        // initial and post-authorization precondition derivations.
        const diagnostic = await readFeatureEvidence(
          f.dir,
          interrupted.diagnosticEvidenceRef,
        );
        assert.equal(diagnostic.timings.kind, "feature", point);
        assert.ok(diagnostic.timings.precondition_checks >= 2, point);
        assert.equal(
          (
            await f.validate({
              resumeEvidenceRef: interrupted.startedReference,
            })
          ).status,
          "BLOCKED",
        );
        assert.equal((await f.validate()).status, "PASSED");
      }
    }
  },
);

test(
  "no UI authority, task changes during checks and tampered feature evidence fail closed",
  integration,
  async (t) => {
    const f = await fixture(t);
    await f.add("one");
    await f.finish("one");
    assert.equal(
      (await f.validate({}, { authorize: undefined })).status,
      "BLOCKED",
    );
    assert.equal(
      (await f.validate({}, { authorize: async () => false })).status,
      "BLOCKED",
    );
    const passed = await f.validate();
    assert.equal(passed.status, "PASSED");
    await writeFile(await artifactPath(f.dir, passed.evidenceRef), "{}");
    assert.equal(
      (await f.validate({ resumeEvidenceRef: passed.evidenceRef })).status,
      "BLOCKED",
    );
    const r = await f.validate(
      {},
      {
        interrupt: async (stage) => {
          if (stage === "beforeReview") await f.add("correction", ["one"]);
        },
      },
    );
    assert.equal(r.status, "BLOCKED");
  },
);

test("verification subprocess bounds, cancellation and diagnostics preserve actual exit codes", async () => {
  const run = (code, options = {}) =>
    runCheck([process.execPath, "-e", code], options);
  assert.equal(
    (await run('console.error("failure detail");process.exit(9)')).exit_code,
    9,
  );
  assert.equal((await run('console.log("ok")')).stdout.trim(), "ok");
  assert.equal(
    (await run("setInterval(()=>{},1000)", { timeoutMs: 50 })).problem,
    "TIMEOUT",
  );
  assert.equal(
    (
      await run(
        'process.stdout.write("x".repeat(100000));setInterval(()=>{},1000)',
      )
    ).problem,
    "OUTPUT_LIMIT",
  );
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 50);
  assert.equal(
    (await run("setInterval(()=>{},1000)", { signal: controller.signal }))
      .problem,
    "CANCELLED",
  );
  assert.equal((await runCheck(["missing-check-program"])).problem, "ENOENT");
});

test(
  "restored tracked edits fail, ignored generated outputs pass, and invalid review plans run no commands",
  integration,
  async (t) => {
    const f = await fixture(t);
    await f.add("one");
    await f.finish("one");
    const restored = await f.validate({
      testCommand: [
        process.execPath,
        "-e",
        'const fs=require("fs");const original=fs.readFileSync("source.txt");fs.writeFileSync("source.txt","transient");fs.writeFileSync("source.txt",original);console.log("12 integration tests passed")',
      ],
    });
    assert.equal(restored.status, "BLOCKED", JSON.stringify(restored));
    const generated = await f.validate({
      testCommand: [
        process.execPath,
        "-e",
        'const fs=require("fs");fs.mkdirSync("output",{recursive:true});fs.writeFileSync("output/report.txt","generated");console.log("12 integration tests passed")',
      ],
    });
    assert.equal(generated.status, "PASSED", JSON.stringify(generated));
    const invalid = await f.validate({
      review: { maxTurns: 0 },
      buildCommand: [
        process.execPath,
        "-e",
        'require("fs").writeFileSync("source.txt","must not run")',
      ],
    });
    assert.equal(invalid.status, "BLOCKED");
    assert.equal(f.g("status", "--porcelain"), "");
  },
);

test(
  "interrupted check/review and failed completion retention remain recoverable diagnostics",
  integration,
  async (t) => {
    const f = await fixture(t);
    await f.add("one");
    await f.finish("one");
    const timeout = await f.validate({
      testCommand: [process.execPath, "-e", "setInterval(()=>{},1000)"],
      checkTimeoutMs: 100,
    });
    assert.equal(timeout.status, "BLOCKED");
    const receipt = await readFeatureEvidence(f.dir, timeout.evidenceRef);
    assert.ok(receipt.checks.some((c) => c.problem === "TIMEOUT"));
    await f.reviewer("APPROVED", "while(true) {}");
    const blocked = await f.validate(
      {},
      { reviewOptions: { ...f.options.reviewOptions, timeoutMs: 100 } },
    );
    assert.equal(blocked.status, "BLOCKED");
    await f.reviewer();
    const invokeScaffold = invoke;
    const failedHandoff = await f.validate(
      {},
      {
        scaffoldOptions: {
          invokeScaffold: async (program, args, ctx) =>
            args[0] === "validation-record"
              ? { code: 1, stderr: "simulated handoff outage" }
              : invokeScaffold(program, args, ctx),
        },
      },
    );
    assert.equal(failedHandoff.status, "BLOCKED");
    assert.equal(
      (await readFeatureEvidence(f.dir, failedHandoff.evidenceRef)).result
        .status,
      "PASSED",
    );
    assert.equal(
      (await f.validate({ resumeEvidenceRef: failedHandoff.evidenceRef }))
        .status,
      "PASSED",
    );
  },
);

test("Git design references are rejected; context hashes are required", async () => {
  const { approvedDesign } = await import("../pi/agent/lib/verification/feature.mjs");
  assert.throws(() => approvedDesign("/unused", {
    context: "Original approved design", design_ref: "approved.md@" + "a".repeat(40),
  }), /design|context/i);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { chmod } from "node:fs/promises";
import { invoke, scaffoldCliUsage, scaffoldCliUsageSince } from "../pi/agent/extensions/scaffold/adapter.mjs";
import {
  TIMINGS_SCHEMA,
  combineScaffoldUsage,
  featureTimings,
  ledgerEventCount,
  readStageTimings,
  repositoryTimings,
  stopwatch,
  summarizeTimings,
  taskTimings,
  timingPath,
} from "../pi/agent/lib/verification/timings.mjs";

const run = promisify(execFile);
const stageScript = fileURLToPath(
  new URL("../pi/agent/extensions/execute-and-review/command-stage.mjs", import.meta.url),
);

async function directory(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-timings-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

// Run the real stage wrapper for a trivial command, as Conductor would.
async function runStage(dir, { program = process.execPath, args = ["-e", ""], index = 0, preSidecar } = {}) {
  const receipt = path.join(dir, `${index}.receipt.json`);
  const stageFile = path.join(dir, `${index}.stage.json`);
  await writeFile(stageFile, JSON.stringify({
    repository: dir, index, receipt,
    command: { name: "probe", program, args },
  }));
  if (preSidecar) await writeFile(timingPath(receipt), preSidecar);
  let code = 0;
  try { await run(process.execPath, [stageScript, stageFile]); }
  catch (error) { code = error.code; }
  return { code, receipt };
}

test("stopwatch reports a start time and a monotonic, non-negative duration", async () => {
  const clock = stopwatch();
  await new Promise((resolve) => setTimeout(resolve, 15));
  const elapsed = clock.elapsed();
  assert.ok(Number.isFinite(Date.parse(clock.startedAt)));
  assert.ok(elapsed >= 10 && elapsed < 5000, `elapsed ${elapsed}`);
  assert.ok(clock.elapsed() >= elapsed);
});

test("stage wrapper writes a timing sidecar and leaves the authenticated receipt unchanged", async (t) => {
  const dir = await directory(t);
  const { code, receipt } = await runStage(dir);
  assert.equal(code, 0);
  const body = JSON.parse(await readFile(receipt, "utf8"));
  // Receipt shape is exactly what authenticators and the review handoff digest see today.
  assert.deepEqual(Object.keys(body).sort(), [
    "args", "exit_code", "index", "name", "program", "schema", "signal", "status",
  ].sort());
  assert.equal(body.status, "PASSED");
  const sidecar = JSON.parse(await readFile(timingPath(receipt), "utf8"));
  assert.equal(sidecar.schema, TIMINGS_SCHEMA);
  assert.equal(sidecar.index, 0);
  assert.ok(sidecar.duration_ms >= 0);
  for (const key of ["snapshot_ms", "handoff_ms", "process_ms", "snapshot_after_ms"])
    assert.ok(Number.isFinite(sidecar[key]), key);
  assert.equal(sidecar.reused, false);
  // The component laps cannot exceed the stage total.
  const laps = sidecar.snapshot_ms + sidecar.handoff_ms + sidecar.process_ms + sidecar.snapshot_after_ms;
  assert.ok(laps <= sidecar.duration_ms + 1, `${laps} > ${sidecar.duration_ms}`);
});

test("identical commands retain identical receipts regardless of how long each took", async (t) => {
  // Two runs differ in timing but must retain byte-identical receipts for identical commands.
  const a = await directory(t), b = await directory(t);
  const first = await runStage(a), second = await runStage(b);
  const digest = async (file) => createHash("sha256").update(await readFile(file)).digest("hex");
  assert.equal(await digest(first.receipt), await digest(second.receipt));
});

test("a failing command keeps its exit code and still records timing", async (t) => {
  const dir = await directory(t);
  const { code, receipt } = await runStage(dir, { args: ["-e", "process.exit(7)"] });
  assert.equal(code, 7);
  assert.equal(JSON.parse(await readFile(receipt, "utf8")).status, "FAILED");
  assert.ok(JSON.parse(await readFile(timingPath(receipt), "utf8")).duration_ms >= 0);
});

test("telemetry write failure never changes the stage outcome", async (t) => {
  const dir = await directory(t);
  // A pre-existing sidecar makes the exclusive write fail.
  const { code, receipt } = await runStage(dir, { preSidecar: "pre-existing" });
  assert.equal(code, 0);
  assert.equal(JSON.parse(await readFile(receipt, "utf8")).status, "PASSED");
  assert.equal(await readFile(timingPath(receipt), "utf8"), "pre-existing");
});

test("readStageTimings tolerates missing, malformed, mismatched and symlinked sidecars", async (t) => {
  const dir = await directory(t);
  const specs = [{ name: "execute" }, { name: "compile" }, { name: "tests" }, { name: "review" }];
  const good = (index, ms) => JSON.stringify({ schema: TIMINGS_SCHEMA, index, started_at: "2026-01-01T00:00:00.000Z", duration_ms: ms, process_ms: ms });
  await writeFile(path.join(dir, "0.timing.json"), good(0, 1200));
  await writeFile(path.join(dir, "1.timing.json"), "{ not json");
  await writeFile(path.join(dir, "2.timing.json"), good(9, 50)); // wrong index
  await writeFile(path.join(dir, "real.json"), good(3, 999));
  await symlink(path.join(dir, "real.json"), path.join(dir, "3.timing.json"));
  const stages = await readStageTimings(dir, specs, 4);
  assert.deepEqual(stages.map((s) => s.duration_ms), [1200, null, null, null]);
  assert.deepEqual(stages.map((s) => s.name), ["execute", "compile", "tests", "review"]);
});

test("taskTimings splits execution, checks and review and counts missing stages", () => {
  const stages = [
    { index: 0, name: "execute", duration_ms: 1000 },
    { index: 1, name: "compile", duration_ms: 2000 },
    { index: 2, name: "tests", duration_ms: 3000 },
    { index: 3, name: "review", duration_ms: 40000 },
  ];
  const t = taskTimings({ stages, ledgerEvents: 12, sealPrepMs: 250, attempt: 2 });
  assert.equal(t.schema, TIMINGS_SCHEMA);
  assert.equal(t.execution_ms, 1000);
  assert.equal(t.checks_ms, 5000);
  assert.equal(t.review_ms, 40000);
  assert.equal(t.review_ledger_events, 12);
  assert.equal(t.attempt, 2);
  assert.equal(t.missing_stage_timings, 0);
  stages[2] = { index: 2, name: "tests", duration_ms: null };
  const partial = taskTimings({ stages, sealPrepMs: 1 });
  assert.equal(partial.checks_ms, 2000);
  assert.equal(partial.missing_stage_timings, 1);
  assert.equal(partial.review_ledger_events, null);
});

test("ledgerEventCount counts raw lines and reports unavailable ledgers as null", async (t) => {
  const dir = await directory(t);
  const file = path.join(dir, "review-ledger.jsonl");
  await writeFile(file, '{"e":1}\n{"e":2}\n\n{"e":3}\n');
  assert.equal(await ledgerEventCount(file), 3);
  assert.equal(await ledgerEventCount(path.join(dir, "absent.jsonl")), null);
});

test("featureTimings totals checks and reports precondition re-check cost", () => {
  const t = featureTimings({
    checks: [{ name: "build", duration_ms: 1500 }, { name: "test", duration_ms: 2500 }],
    reviewMs: 9000, totalMs: 15000, rechecks: { count: 6, ms: 1234.5678 },
  });
  assert.equal(t.kind, "feature");
  assert.equal(t.checks_ms, 4000);
  assert.equal(t.precondition_checks, 6);
  assert.equal(t.precondition_ms, 1234.568);
  assert.equal(t.review_ms, 9000);
});

test("receipts without telemetry are summarized as unavailable, not as errors", async (t) => {
  assert.deepEqual(summarizeTimings({ result: { status: "PASSED" } }), {
    available: false, reason: "Receipt has no timing telemetry",
  });
  assert.equal(summarizeTimings({ timings: { schema: "other/v9" } }).available, false);
  const timings = taskTimings({ stages: [{ index: 0, name: "execute", duration_ms: 5 }], sealPrepMs: 1 });
  assert.equal(summarizeTimings({ timings }).available, true);

  const dir = await directory(t);
  const hash = "a".repeat(64), other = "b".repeat(64);
  // Receipts are ledger artifacts: files named by their digest, with no extension.
  await writeFile(path.join(dir, hash), JSON.stringify({
    schema: "pi.task-attempt/v1", recordedAt: "2026-01-01T00:00:00.000Z", task: { taskId: "SA-1" }, result: { status: "PASSED" },
  }));
  await writeFile(path.join(dir, other), JSON.stringify({
    schema: "pi.task-attempt/v1", recordedAt: "2026-01-02T00:00:00.000Z", task: { taskId: "SA-2" }, result: { status: "PASSED" }, timings,
  }));
  await writeFile(path.join(dir, "c".repeat(64)), JSON.stringify({ approved: "not a pi receipt" }));
  await writeFile(path.join(dir, "not-a-receipt"), "{}");
  const rows = await repositoryTimings(dir);
  assert.deepEqual(rows.map((r) => [r.task, r.available]), [["SA-1", false], ["SA-2", true]]);
});

test("combineScaffoldUsage totals both processes and reports a missing child as unknown", () => {
  const parent = { calls: 3, totalMs: 120.5 };
  const both = combineScaffoldUsage(parent, { calls: 2, totalMs: 80.25 });
  assert.equal(both.calls, 5);
  assert.equal(both.totalMs, 200.75);
  assert.equal(both.complete, true);
  assert.deepEqual(both.pi_process, parent);
  assert.deepEqual(both.finalization_process, { calls: 2, totalMs: 80.25 });
  for (const missing of [undefined, null, {}, { calls: "2", totalMs: 1 }]) {
    const partial = combineScaffoldUsage(parent, missing);
    assert.equal(partial.calls, 3);
    assert.equal(partial.complete, false);
    assert.equal(partial.finalization_process, null);
  }
});

test("Scaffold CLI accounting counts Scaffold invocations only, not Git probes", { skip: process.platform === "win32" }, async (t) => {
  const dir = await directory(t);
  const fake = path.join(dir, "scaffold");
  await writeFile(fake, "#!/bin/sh\necho '{}'\n");
  await chmod(fake, 0o755);
  const before = scaffoldCliUsage();

  await invoke("git", ["--version"], { cwd: dir });
  await invoke(process.execPath, ["-e", ""], { cwd: dir });
  assert.deepEqual(scaffoldCliUsageSince(before), { calls: 0, totalMs: 0 });

  const result = await invoke(fake, ["summary", "--feature=F"], { cwd: dir });
  assert.equal(result.code, 0);
  await invoke(fake, ["issue", "--feature=F"], { cwd: dir });
  const used = scaffoldCliUsageSince(before);
  assert.equal(used.calls, 2);
  assert.ok(used.totalMs > 0);
});

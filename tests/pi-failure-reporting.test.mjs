// Failure surfacing: one envelope for every tool, a code-to-remedy table that covers every code the
// pipeline can emit, and failures recorded in the feature's ledger (real Scaffold).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { git } from "../pi/agent/lib/git/tree.mjs";
import { FAILURE_CODES, NOT_FAILURE_CODES, describeCode } from "../pi/agent/lib/failure/codes.mjs";
import { exceptionEnvelope, failureEnvelope, isFailure, recordFailure } from "../pi/agent/lib/failure/report.mjs";
import { reportFailures } from "../pi/agent/lib/failure/tool.mjs";
import { retainEvidence } from "../pi/agent/lib/evidence/store.mjs";
import { workDirectory } from "../pi/agent/lib/git/workspace.mjs";
import { ledgerFeature } from "./helpers/ledger-feature.mjs";

const root = path.resolve(import.meta.dirname, "..");
const hasFailureRecord =
  spawnSync("scaffold", ["failure-record", "--help"], { encoding: "utf8" }).status === 0;
const real = { skip: !hasFailureRecord && "Scaffold with failure-record is not on PATH" };

async function sources(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await sources(file)));
    else if (/\.(mjs|ts)$/.test(entry.name)) out.push(file);
  }
  return out;
}

test("every failure code the pipeline can emit has an owner and a remedy", async () => {
  // Any UPPER_SNAKE string in the source could be a code, however it is emitted (a literal argument, a constant,
  // a helper call, a conditional). Each must be in the table, or deliberately listed as not a code.
  const found = new Map();
  for (const file of [...(await sources(path.join(root, "pi/agent/lib"))), ...(await sources(path.join(root, "pi/agent/extensions")))]) {
    if (file.includes("/lib/failure/")) continue;
    for (const m of (await readFile(file, "utf8")).matchAll(/["']([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)["']/g)) found.set(m[1], file);
  }
  const missing = [...found]
    .filter(([code]) => !FAILURE_CODES[code] && !NOT_FAILURE_CODES.has(code))
    .map(([code, file]) => `${code} (${path.relative(root, file)})`);
  assert.deepEqual(missing, [], "add each to FAILURE_CODES in lib/failure/codes.mjs, or to NOT_FAILURE_CODES if it is not a code");
  assert.deepEqual([...NOT_FAILURE_CODES].filter((c) => FAILURE_CODES[c]), [], "a code cannot also be listed as not a code");
  for (const [code, entry] of Object.entries(FAILURE_CODES)) {
    assert.match(code, /^[A-Z][A-Z0-9_]{2,63}$/, code);
    assert.ok(["agent", "user", "bug"].includes(entry.owner), code);
    assert.ok(entry.info || entry.next.length > 0, code + " needs a next step");
    for (const step of entry.next) assert.ok(step.length <= 300, code);
  }
});

test("an envelope says what failed, who acts and what to do, from any result shape", () => {
  const ok = failureEnvelope("checkpoint_verified_task", { ok: false, reason: "CHECKPOINT_BLOCKED", message: "Tree differs", recovery: "Do not reset" });
  assert.deepEqual([ok.code, ok.owner, ok.tool, ok.message], ["CHECKPOINT_BLOCKED", "agent", "checkpoint_verified_task", "Tree differs"]);
  assert.ok(ok.next.includes("Do not reset"));

  const blocked = failureEnvelope("execute_and_review", { status: "BLOCKED", stage: "PRECHECK", reason: "SCAFFOLD_REVIEW_SCOPE", message: "m", evidence: { reference: "sha256:" + "a".repeat(64) } });
  assert.deepEqual([blocked.owner, blocked.stage, blocked.evidence], ["user", "PRECHECK", "sha256:" + "a".repeat(64)]);

  // The Scaffold rule that fired is the message, not "inspect persisted state".
  const refused = failureEnvelope("scaffold_tasks", { ok: false, reason: "COMMAND_FAILED", message: "Scaffold command failed; inspect persisted state before retrying",
    stderr: '{"error":"Completion must cite the receipt"}', scaffold_error: { error: "Completion must cite the receipt" } });
  assert.equal(refused.message, "Completion must cite the receipt");
  assert.match(refused.cause, /Completion must cite/);

  const retry = failureEnvelope("execute_and_review", { status: "NEEDS_DESIGN", stage: "VERIFICATION", evidence: { reference: "sha256:" + "b".repeat(64) } });
  assert.deepEqual([retry.code, retry.owner], ["NEEDS_DESIGN", "agent"]);
  assert.match(retry.next[0], /previousAttempt/);

  assert.equal(failureEnvelope("x", { status: "BLOCKED", reason: "ISSUE_SUSPENDED" }), null, "a parked issue is not a failure");
  assert.equal(failureEnvelope("x", { ok: true }), null);
  assert.equal(failureEnvelope("x", { status: "PASSED" }), null);
  const unknown = failureEnvelope("x", { ok: false, reason: "SOMETHING_NEW", message: "m" });
  assert.equal(unknown.code, "SOMETHING_NEW");
  assert.equal(failureEnvelope("x", { ok: false }).code, "UNSPECIFIED_FAILURE");
  assert.equal(describeCode("SOMETHING_NEW"), FAILURE_CODES.UNSPECIFIED_FAILURE);
  assert.ok(isFailure({ ok: false }) && isFailure({ status: "BLOCKED" }) && !isFailure({ status: "NEEDS_DESIGN" }));

  const bug = exceptionEnvelope("validate_feature", Object.assign(new Error("boom"), { stack: "Error: boom\n  at a\n  at b" }));
  assert.deepEqual([bug.code, bug.owner], ["INTERNAL_ERROR", "bug"]);
  assert.match(bug.cause, /at a/);
});

test("a successful read is never treated as a failure, whatever status it copies", () => {
  // inspect_issue_attempt returns ok:true and copies the retained attempt's status.
  for (const status of ["BLOCKED", "NEEDS_DESIGN"])
    assert.equal(failureEnvelope("inspect_issue_attempt", { ok: true, status, reason: "RESOURCE_PAUSED" }), null, status);
  assert.equal(isFailure({ ok: true, status: "BLOCKED" }), false);
  assert.ok(isFailure({ ok: false, status: "PASSED" }));
});

test("a blocked result without a top-level reason is diagnosed from the review engine and the verification failure", () => {
  const blocked = (conductor) => ({ status: "BLOCKED", stage: "REVIEW", conductor });
  const auth = failureEnvelope("execute_and_review", blocked({ review: { status: "BLOCKED", reason: "AUTHENTICATION_FAILURE", findings: [] }, checks: [] }));
  assert.deepEqual([auth.code, auth.owner, auth.message], ["AUTHENTICATION_FAILURE", "user", "Independent review stopped: AUTHENTICATION_FAILURE"]);
  const budget = failureEnvelope("execute_and_review", blocked({ review: { status: "BLOCKED", reason: "BUDGET_EXHAUSTED", findings: [] }, checks: [] }));
  assert.deepEqual([budget.code, budget.owner], ["BUDGET_EXHAUSTED", "agent"]);
  assert.match(budget.next[0], /budget/i);
  // CHANGES_REQUESTED is a finding to fix, not an engine failure.
  const findings = failureEnvelope("execute_and_review", blocked({ review: { status: "CHANGES_REQUESTED", reason: "REVIEW_COMPLETED", findings: [] }, checks: [] }));
  assert.equal(findings.code, "UNSPECIFIED_FAILURE");

  const engine = failureEnvelope("execute_and_review", blocked({ failure: { category: "review_engine", code: "ENGINE_CRASHED" }, checks: [] }));
  assert.deepEqual([engine.code, engine.owner], ["ENGINE_CRASHED", "user"]);
  assert.match(engine.message, /review_engine.*ENGINE_CRASHED/);
  const integrity = failureEnvelope("execute_and_review", blocked({ failure: { category: "evidence_integrity", code: "TOOL_RESULT_BAD" }, checks: [] }));
  assert.equal(integrity.owner, "bug");
  const invocation = failureEnvelope("execute_and_review", blocked({ failure: { category: "invocation", code: "TOOL_NOT_RUN" }, checks: [] }));
  assert.equal(invocation.owner, "agent");

  const check = failureEnvelope("execute_and_review", blocked({ checks: [{ name: "build", status: "PASSED", exit_code: 0 }, { name: "test", status: "FAILED", exit_code: 1, stderr: "AssertionError at foo.test.js:14" }] }));
  assert.equal(check.message, "Check test exited 1");
  assert.match(check.cause, /AssertionError/);
  // An explicit top-level reason still wins.
  assert.equal(failureEnvelope("execute_and_review", { status: "BLOCKED", reason: "HEAD_CHANGED", conductor: { review: { status: "BLOCKED", reason: "AUTHENTICATION_FAILURE" } } }).code, "HEAD_CHANGED");
  // The nested form used by finalization failures.
  const nested = failureEnvelope("execute_and_review", { status: "BLOCKED", actualResult: { conductor: { review: { status: "BLOCKED", reason: "NETWORK_FAILURE" } } } });
  assert.deepEqual([nested.code, nested.owner], ["NETWORK_FAILURE", "user"]);
});

test("correction guidance only names inputs the tool accepts", () => {
  const guidance = (tool) => failureEnvelope(tool, { status: "NEEDS_DESIGN", message: "Project check failed: test" });
  assert.match(guidance("execute_and_review").next.join(" "), /previousAttempt/);
  for (const tool of ["validate_feature", "rewrite_feature_history", "some_other_tool"])
    assert.doesNotMatch(guidance(tool).next.join(" "), /previousAttempt/, tool);
  assert.match(guidance("validate_feature").next[0], /corrective issue/);
  assert.equal(guidance("rewrite_feature_history").owner, "user");
  assert.equal(guidance("some_other_tool").owner, "agent");
});

async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-failure-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const g = (...args) => git(dir, args);
  g("init", "-q", "-b", "main");
  g("config", "user.name", "Test");
  g("config", "user.email", "test@example.invalid");
  g("config", "core.autocrlf", "false");
  g("config", "core.excludesfile", "");
  await writeFile(path.join(dir, ".gitignore"), ".scaffold/\n");
  await writeFile(path.join(dir, "value.txt"), "before\n");
  g("add", ".");
  g("commit", "-qm", "baseline");
  const ledger = await ledgerFeature(dir, { featureId: "F1", taskId: "a", branch: "feature/failures", start: false });
  return { dir, ledger, task: { featureId: "F1", taskId: "a", designRef: ledger.designRef } };
}

const toolReturning = (name, details) => ({
  name,
  async execute() {
    return { content: [{ type: "text", text: JSON.stringify(details) }], isError: details.ok === false || details.status === "BLOCKED", details };
  },
});
const run = (tool, params, dir) => reportFailures(tool).execute("call", params, undefined, undefined, { cwd: dir });
const failures = async (f) => (await f.ledger.feature()).failures ?? [];

test("a blocked tool result gains the envelope and is recorded in the ledger", real, async (t) => {
  const f = await fixture(t);
  const out = await run(toolReturning("checkpoint_verified_task", { ok: false, reason: "CHECKPOINT_BLOCKED", message: "Tree differs from the receipt" }), { task: f.task }, f.dir);
  const shown = JSON.parse(out.content[0].text);
  assert.equal(shown.reason, "CHECKPOINT_BLOCKED"); // the tool's own fields are kept
  assert.deepEqual([shown.failure.code, shown.failure.owner, shown.failure.recorded], ["CHECKPOINT_BLOCKED", "agent", true]);
  assert.equal(out.isError, true);
  const [recorded] = await failures(f);
  assert.deepEqual([recorded.code, recorded.tool, recorded.owner, recorded.task_id], ["CHECKPOINT_BLOCKED", "checkpoint_verified_task", "agent", "a"]);
});

test("an exception a tool did not handle becomes a recorded failure owned by 'bug'", real, async (t) => {
  const f = await fixture(t);
  const tool = { name: "validate_feature", async execute() { throw new Error("Cannot read properties of undefined (reading 'status')"); } };
  const out = await run(tool, { featureId: "F1" }, f.dir);
  const shown = JSON.parse(out.content[0].text);
  assert.equal(out.isError, true);
  assert.deepEqual([shown.failure.code, shown.failure.owner, shown.failure.recorded], ["INTERNAL_ERROR", "bug", true]);
  assert.match(shown.failure.cause, /Cannot read properties|at /);
  const [recorded] = await failures(f);
  assert.equal(recorded.code, "INTERNAL_ERROR");
  // The full record, with its cause, is the ledger entry.
  const dirs = await readdir(path.join(f.dir, ".scaffold", "features"));
  const entries = (await readFile(path.join(f.dir, ".scaffold", "features", dirs[0], "ledger.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  assert.match(entries.at(-1).body.payload.cause, /Cannot read properties/);
});

test("a NEEDS_DESIGN attempt gets guidance but is not logged twice (its receipt is already in the ledger)", real, async (t) => {
  const f = await fixture(t);
  const out = await run(toolReturning("execute_and_review", { status: "NEEDS_DESIGN", stage: "VERIFICATION" }), { task: f.task }, f.dir);
  const shown = JSON.parse(out.content[0].text);
  assert.equal(shown.failure.owner, "agent");
  assert.match(shown.failure.next[0], /previousAttempt/);
  assert.equal(shown.failure.recorded, null);
  assert.deepEqual(await failures(f), []);
});

test("a failure is not lost to an unknown task or an unstored evidence reference", real, async (t) => {
  const f = await fixture(t);
  const details = { ok: false, reason: "CHECKPOINT_BLOCKED", message: "m", evidence: { reference: "sha256:" + "9".repeat(64) } };
  const out = await run(toolReturning("checkpoint_verified_task", details), { task: { ...f.task, taskId: "no-such-task" } }, f.dir);
  assert.equal(JSON.parse(out.content[0].text).failure.recorded, true);
  const [recorded] = await failures(f);
  assert.equal(recorded.task_id, undefined, "recorded against the feature when the task is unknown");
});

test("recording never throws or hides the failure: no feature, no Scaffold, no repository", real, async (t) => {
  const f = await fixture(t);
  const details = { ok: false, reason: "CHECKPOINT_BLOCKED", message: "original failure" };
  const noFeature = await run(toolReturning("t", details), {}, f.dir);
  assert.deepEqual([JSON.parse(noFeature.content[0].text).failure.recorded, JSON.parse(noFeature.content[0].text).message], [false, "original failure"]);
  const unknownFeature = await run(toolReturning("t", details), { featureId: "NOPE" }, f.dir);
  assert.equal(JSON.parse(unknownFeature.content[0].text).failure.recorded, false);
  const notARepo = await mkdtemp(path.join(tmpdir(), "pi-not-a-repo-"));
  t.after(() => rm(notARepo, { recursive: true, force: true }));
  assert.equal(await recordFailure(notARepo, { featureId: "F1" }, exceptionEnvelope("t", new Error("x"))), false);
  const broken = await recordFailure(f.dir, { featureId: "F1" }, exceptionEnvelope("t", new Error("x")), {
    scaffoldOptions: { invokeScaffold: async () => ({ code: 127, stderr: "scaffold: command not found" }) },
  });
  assert.equal(broken, false);
  assert.deepEqual(await failures(f), []);
});

test("a result that is not a failure passes through untouched", real, async (t) => {
  const f = await fixture(t);
  const original = toolReturning("validate_feature", { status: "PASSED", message: "ok" });
  const out = await run(original, { featureId: "F1" }, f.dir);
  assert.deepEqual(out, await original.execute());
  assert.deepEqual(await failures(f), []);
});

test("a failure of a reference-only continuation is recorded against the task its reference names", real, async (t) => {
  const f = await fixture(t);
  const details = { status: "BLOCKED", stage: "PAUSED", reason: "RESOURCE_PAUSED", message: "Persisted review context exceeds its allowance" };

  // previousAttempt: the receipt in the ledger carries the binding.
  const receipt = await retainEvidence(f.dir, {
    repository: f.dir, task: f.task, attempt: 1, args: { baseRef: f.ledger.baseline }, before: {}, after: {}, result: { status: "NEEDS_DESIGN" },
  });
  const byReceipt = await run(toolReturning("execute_and_review", details), { previousAttempt: receipt }, f.dir);
  assert.equal(JSON.parse(byReceipt.content[0].text).failure.recorded, true);

  // issueHandoffRef: the saved handoff carries the binding.
  const bytes = JSON.stringify({ schema: "pi.issue-context/v1", repository: await realpath(f.dir), binding: f.task, recorded_at: "2026-11-10T00:00:00Z" });
  const hash = createHash("sha256").update(bytes).digest("hex");
  await mkdir(workDirectory(await realpath(f.dir), "handoffs"), { recursive: true });
  await writeFile(path.join(workDirectory(await realpath(f.dir), "handoffs"), hash + ".json"), bytes);
  const byHandoff = await run(toolReturning("execute_and_review", details), { issueHandoffRef: "pi-issue-context:sha256:" + hash }, f.dir);
  assert.equal(JSON.parse(byHandoff.content[0].text).failure.recorded, true);

  // The result itself can name the task.
  const byResult = await run(toolReturning("execute_and_review", { ...details, evidence: { reference: receipt, task: f.task, attempt: 1 } }), { previousAttempt: "sha256:" + "0".repeat(64) }, f.dir);
  assert.equal(JSON.parse(byResult.content[0].text).failure.recorded, true);

  // Nothing identifies a feature: not recorded, and the failure is still shown.
  const none = await run(toolReturning("execute_and_review", details), { previousAttempt: "sha256:" + "1".repeat(64) }, f.dir);
  assert.equal(JSON.parse(none.content[0].text).failure.recorded, false);

  const recorded = await failures(f);
  assert.equal(recorded.length, 3);
  assert.ok(recorded.every((r) => r.code === "RESOURCE_PAUSED" && r.task_id === "a"), JSON.stringify(recorded));
});

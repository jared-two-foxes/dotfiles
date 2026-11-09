import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { git } from "../pi/agent/lib/git/tree.mjs";
import { authenticateIssueMutation } from "../pi/agent/lib/verification/issue-mutation.mjs";
import {
  prepareIssueHandoff,
  inspectIssueHandoff,
  readIssueHandoff,
} from "../pi/agent/lib/verification/issue-handoff.mjs";
import {
  assertDeliveryJournal,
  anchorDeliveryJournal,
  deliveryContractItems,
} from "../pi/agent/lib/delivery-state/delivery-context.mjs";

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-delivery-state-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  git(directory, ["init", "-q", "-b", "feature/delivery"]);
  await appendFile(path.join(directory, ".git", "info", "exclude"), ".scaffold/\n");
  git(directory, ["config", "user.name", "Test"]);
  git(directory, ["config", "user.email", "test@example.invalid"]);
  git(directory, ["config", "core.autocrlf", "false"]);
  await writeFile(path.join(directory, "source.txt"), "baseline\n");
  git(directory, ["add", "."]);
  git(directory, ["commit", "-qm", "baseline"]);
  return {
    context: { directory },
    args: { featureId: "F", taskId: "T" },
    capsule: {
      feature: { id: "F", branch: "feature/delivery", design_ref: "approved-design" },
      issue: { id: "T", status: "pending" },
    },
  };
}

test("delivery-state has no direct or transitive Scaffold runtime dependency", async () => {
  const directory = fileURLToPath(new URL("../pi/agent/lib/delivery-state/", import.meta.url));
  const scaffold = fileURLToPath(new URL("../pi/agent/lib/scaffold/", import.meta.url));
  const visited = new Set();
  async function visit(file) {
    if (visited.has(file)) return;
    visited.add(file);
    assert.equal(file.startsWith(scaffold) && file !== path.join(scaffold, "contracts.mjs"), false, "Runtime dependency: " + file);
    const source = await readFile(file, "utf8");
    const imports = source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)["'](\.[^"']+)["']/g);
    for (const [, specifier] of imports)
      await visit(path.resolve(path.dirname(file), specifier));
  }
  for (const name of await readdir(directory))
    if (name.endsWith(".mjs")) await visit(path.join(directory, name));
  const issueState = await import("../pi/agent/lib/scaffold/contracts.mjs");
  assert.equal(Object.hasOwn(issueState, "issueMutation"), false);
});

test("handoffs consume supplied issue data without Scaffold state or CLI access", async (t) => {
  const f = await fixture(t);
  const saved = await prepareIssueHandoff(f.args, { capsule: f.capsule }, f.context);
  assert.equal(saved.ok, true, JSON.stringify(saved));
  const current = await inspectIssueHandoff(
    { reference: saved.reference }, { capsule: f.capsule }, f.context,
  );
  assert.equal(current.applicable, true, JSON.stringify(current));
  assert.deepEqual(current.handoff.capsule, f.capsule);
  assert.equal((await readIssueHandoff(f.args, f.context)).reference, saved.reference);

  const changed = structuredClone(f.capsule);
  changed.issue.status = "in_progress";
  const stale = await inspectIssueHandoff(
    { reference: saved.reference }, { capsule: changed }, f.context,
  );
  assert.equal(stale.ok, true);
  assert.equal(stale.applicable, false);
  assert.match(stale.reason, /Graph\/design\/lifecycle changed/);
  assert.deepEqual(stale.refresh, { tool: "prepare_issue_handoff", ...f.args });
  assert.equal((await prepareIssueHandoff(f.args, {}, f.context)).ok, false);
  assert.equal((await prepareIssueHandoff(
    { ...f.args, taskId: "other" }, { capsule: f.capsule }, f.context,
  )).ok, false);

  await writeFile(path.join(f.context.directory, "source.txt"), "changed\n");
  const sourceChanged = await inspectIssueHandoff(
    { reference: saved.reference }, { capsule: f.capsule }, f.context,
  );
  assert.equal(sourceChanged.applicable, false);
  assert.match(sourceChanged.reason, /Git source, index or HEAD changed/);
});

test("journal anchors validate caller-supplied state and never reset retained history", async (t) => {
  const { context } = await fixture(t);
  const task = { featureId: "F", taskId: "T", designRef: "approved-design" };
  const first = { revision: 1, head: null, inflight: null, sequence: 0, context: {}, contract: {} };
  assert.equal(assertDeliveryJournal(context.directory, task, null), null);
  assert.deepEqual(anchorDeliveryJournal(context.directory, task, null, first), first);
  assert.ok(assertDeliveryJournal(context.directory, task, first).sha);
  assert.throws(() => assertDeliveryJournal(context.directory, task, null), /EVIDENCE_RECOVERY_REQUIRED/);
  assert.throws(() => assertDeliveryJournal(
    context.directory, task, { ...first, sequence: 1 },
  ), /EVIDENCE_RECOVERY_REQUIRED/);
  const next = { ...first, revision: 2, sequence: 1, head: "retained-receipt" };
  anchorDeliveryJournal(context.directory, task, first, next);
  assert.ok(assertDeliveryJournal(context.directory, task, next).sha);
  assert.throws(() => anchorDeliveryJournal(context.directory, task, first, first), /EVIDENCE_RECOVERY_REQUIRED/);
});

test("delivery journal anchors remain isolated after clean and recreate of identical task", async (t) => {
  const { context } = await fixture(t);
  const task = { featureId: "F", taskId: "T", designRef: "same-approved-design" };
  const originalInstance = "1".repeat(32);
  const recreatedInstance = "2".repeat(32);
  const original = { revision: 1, head: null, inflight: null, sequence: 0, context: {}, contract: {} };
  const recreated = { ...original, context: { "fresh": true } };

  // Retain the original generation's Git audit anchor; clean never deletes it.
  anchorDeliveryJournal(context.directory, task, null, original, originalInstance);
  assert.ok(assertDeliveryJournal(context.directory, task, original, originalInstance).sha);
  // A new feature generation with the *same* task and design starts clean.
  assert.equal(assertDeliveryJournal(context.directory, task, null, recreatedInstance), null);
  anchorDeliveryJournal(context.directory, task, null, recreated, recreatedInstance);
  assert.ok(assertDeliveryJournal(context.directory, task, recreated, recreatedInstance).sha);
  assert.ok(assertDeliveryJournal(context.directory, task, original, originalInstance).sha);
  assert.throws(
    () => assertDeliveryJournal(context.directory, task, original, recreatedInstance),
    /EVIDENCE_RECOVERY_REQUIRED/,
  );
});

test("pre-instance delivery journal can continue without a silent anchor migration", async (t) => {
  const { context } = await fixture(t);
  const task = { featureId: "F", taskId: "T", designRef: "approved-design" };
  const first = { revision: 1, head: null, inflight: null, sequence: 0, context: {}, contract: {} };
  anchorDeliveryJournal(context.directory, task, null, first);
  // A pre-existing journal written before anchor namespacing is valid only
  // while its exact persisted state remains present, never for a new feature.
  assert.ok(assertDeliveryJournal(context.directory, task, first, "1".repeat(32)).sha);
  const updated = { ...first, revision: 2, sequence: 1, head: "old-receipt" };
  anchorDeliveryJournal(context.directory, task, first, updated, "1".repeat(32));
  assert.ok(assertDeliveryJournal(context.directory, task, updated).sha);
  assert.equal(assertDeliveryJournal(context.directory, task, null, "2".repeat(32)), null);
});

test("contract item identities preserve their persisted hashes", () => {
  const items = deliveryContractItems(
    { objective: "Objective", acceptance_criteria: ["Feature works"], constraints: ["Preserve errors"] },
    { acceptance_criteria: ["Issue works"], constraints: ["No reset"] },
    { taskId: "T" },
  );
  assert.deepEqual(items.map((item) => item.text),
    ["Objective", "Feature works", "Preserve errors", "Issue works", "No reset"]);
  const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
  assert.equal(items[0].id, "feature_objective-" + hash("Objective"));
  assert.equal(items[3].id, "issue_criterion_T_0-" + hash("Issue works"));
});

test("Scaffold callers own reads, writes and post-save freshness checks", {
  skip: !process.execArgv.includes("--experimental-test-module-mocks") &&
    "Requires --experimental-test-module-mocks for runtime boundary isolation",
}, async (suite) => {
  let invoke;
  suite.mock.module("../pi/agent/extensions/scaffold/adapter.mjs", {
    namedExports: {
      scaffoldTasks: (...args) => invoke(...args),
      issueFeature: () => assert.fail("Unexpected full feature lookup"),
    },
  });
  const runtime = await import("../pi/agent/extensions/execution-recovery/issue-context.mjs");
  const journalRuntime = await import("../pi/agent/extensions/execute-and-review/delivery-context.mjs");

  await suite.test("handoff preparation fetches fresh data again after saving", async (t) => {
    const f = await fixture(t);
    let reads = 0;
    invoke = async (params) => {
      assert.equal(params.operation, "issue");
      reads++;
      const capsule = structuredClone(f.capsule);
      if (reads > 1) capsule.issue.status = "in_progress";
      return { ok: true, data: { context: capsule } };
    };
    const saved = await runtime.prepareIssueHandoff(f.args, f.context);
    assert.equal(reads, 2);
    assert.equal(saved.ok, false);
    assert.ok(saved.reference);
    assert.match(saved.message, /Graph\/design\/lifecycle changed/);

    invoke = async () => ({ ok: true, data: { context: f.capsule } });
    const fresh = await runtime.prepareIssueHandoff(f.args, f.context);
    assert.equal(fresh.ok, true, JSON.stringify(fresh));
    assert.equal(fresh.applicable, true);

    invoke = async () => ({ ok: false, message: "Scaffold unavailable" });
    const stale = await runtime.inspectIssueHandoff({ reference: saved.reference }, f.context);
    assert.equal(stale.ok, true);
    assert.equal(stale.applicable, false);
    assert.equal(stale.reason, "Scaffold unavailable");
  });

  await suite.test("journal mutation happens only after anchor validation", async (t) => {
    const { context } = await fixture(t);
    const task = { featureId: "F", taskId: "T", designRef: "approved-design" };
    const next = { revision: 1, head: null, inflight: null, sequence: 0, context: {}, contract: {} };
    const event = { kind: "initialized", context: {}, head: null, sequence: 0 };
    let writes = 0;
    invoke = async (params) => {
      writes++;
      assert.equal(params.operation, "delivery-record");
      assert.deepEqual(params.payload, { expected_revision: 0, event });
      assert.equal(assertDeliveryJournal(context.directory, task, null), null);
      return { ok: true, data: { feature: { tasks: { T: { delivery: next } } } } };
    };
    assert.deepEqual(await journalRuntime.deliveryEvent(context.directory, task, null, event), next);
    assert.ok(assertDeliveryJournal(context.directory, task, next).sha);
    await assert.rejects(journalRuntime.deliveryEvent(context.directory, task, null, event),
      /EVIDENCE_RECOVERY_REQUIRED/);
    assert.equal(writes, 1);
    invoke = async () => ({ ok: false, message: "Persistence failed" });
    await assert.rejects(journalRuntime.deliveryEvent(context.directory, task, next, event),
      /DELIVERY_STATE: Persistence failed/);
    assert.ok(assertDeliveryJournal(context.directory, task, next).sha);
  });

  await suite.test("checkpoint callers pass feature data and authenticate the final lifecycle write", async (t) => {
    const { context } = await fixture(t);
    const feature = { id: "F", tasks: { T: { status: "completed" } } };
    const args = { task: { featureId: "F", taskId: "T", designRef: "approved-design" }, evidenceRef: "receipt" };
    let result = { ok: true, commit: "a".repeat(40), baseRef: "b".repeat(40), tree: "c".repeat(40) };
    suite.mock.module("../pi/agent/extensions/checkpoint/commit.mjs", {
      namedExports: {
        checkpointAuthorization: () => assert.fail("Unexpected authorization factory"),
        checkpointVerifiedTask: async (actualArgs, data, actualContext) => {
          assert.equal(actualArgs, args);
          assert.deepEqual(data, { feature });
          assert.equal(actualContext.directory, context.directory);
          return result;
        },
      },
    });
    const { checkpointVerifiedTask } = await import("../pi/agent/extensions/checkpoint/scaffold.mjs");
    const calls = [];
    let recordFails = false;
    invoke = async (params, _context, options) => {
      calls.push(params.operation);
      if (params.operation === "list") return { ok: true, data: { feature } };
      assert.equal(params.operation, "checkpoint-record");
      assert.deepEqual(params.payload, { commit: result.commit, parent: result.baseRef, tree: result.tree, reference: args.evidenceRef });
      assert.equal(options.authorizeIssueMutation, authenticateIssueMutation);
      return recordFails ? { ok: false, message: "Recording failed" } : { ok: true };
    };
    assert.deepEqual(await checkpointVerifiedTask(args, context), result);
    assert.deepEqual(calls, ["list", "checkpoint-record"]);
    calls.length = 0;
    recordFails = true;
    const blocked = await checkpointVerifiedTask(args, context);
    assert.equal(blocked.ok, false);
    assert.equal(blocked.reason, "CHECKPOINT_BLOCKED");
    assert.equal(blocked.message, "Recording failed");
    assert.deepEqual(calls, ["list", "checkpoint-record"]);
    calls.length = 0;
    result = { ok: false, reason: "CHECKPOINT_BLOCKED", message: "Changed evidence" };
    assert.deepEqual(await checkpointVerifiedTask(args, context), result);
    assert.deepEqual(calls, ["list"]);
  });
});

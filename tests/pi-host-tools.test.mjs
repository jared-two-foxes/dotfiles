import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { defineTool, toolResult, withFailureReporting } from "../pi/agent/lib/host/tool.mjs";
import { piHost, registerPiTools, toPiTool } from "../pi/agent/lib/host/pi.mjs";
import { createCheckpointTools } from "../pi/agent/extensions/checkpoint/tools.mjs";
import { createFeatureValidationTools } from "../pi/agent/extensions/feature-validation/tools.mjs";
import { createScaffoldTools } from "../pi/agent/extensions/scaffold/tools.mjs";
import { createReviewTool } from "../pi/agent/extensions/review/tool.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "pi", "agent");

// Minimal TypeBox-shaped builder: enough to prove definitions only need an injected `Type`.
const Type = new Proxy({}, {
  get: (_t, kind) => (...args) => ({ kind, args }),
});

test("toolResult defaults isError from ok and keeps details", () => {
  const ok = toolResult({ ok: true, n: 1 });
  assert.equal(ok.isError, false);
  assert.deepEqual(JSON.parse(ok.content[0].text), { ok: true, n: 1 });
  assert.equal(ok.details.n, 1);
  assert.equal(toolResult({ ok: false }).isError, true);
  assert.equal(toolResult({ status: "BLOCKED" }, { isError: true }).isError, true);
  assert.equal(toolResult({ ok: true }, { text: { shown: 1 } }).content[0].text, JSON.stringify({ shown: 1 }, null, 2));
});

test("defineTool rejects an incomplete definition at definition time", () => {
  assert.throws(() => defineTool({ name: "x" }), /description/);
  assert.throws(() => defineTool({ name: "x", description: "d", parameters: {}, execute: 1 }), /execute must be a function/);
  const tool = { name: "x", description: "d", parameters: {}, execute() {} };
  assert.equal(defineTool(tool), tool);
});

test("Pi adapter maps Pi's call shape to the neutral host and forwards confirm lazily", async () => {
  let seen;
  const tool = defineTool({
    name: "t", label: "T", description: "d", parameters: {},
    async execute(params, host) { seen = { params, host }; return { ok: await host.confirm("title", "msg") }; },
  });
  const piTool = toPiTool(tool);
  assert.equal(piTool.label, "T");
  const signal = new AbortController().signal;
  const calls = [];
  const ctx = { cwd: "/repo", hasUI: true, ui: { confirm: async (...a) => (calls.push(a), true) } };
  assert.deepEqual(await piTool.execute("call-id", { a: 1 }, signal, undefined, ctx), { ok: true });
  assert.deepEqual(seen.params, { a: 1 });
  assert.equal(seen.host.cwd, "/repo");
  assert.equal(seen.host.signal, signal);
  assert.deepEqual(calls, [["title", "msg"]]);
  // A tool that never confirms must work in a context with no UI (headless).
  assert.equal(piHost(signal, undefined, { cwd: "/r" }).cwd, "/r");
});

test("withFailureReporting gives a neutral tool the shared failure envelope", async () => {
  const boom = withFailureReporting(defineTool({
    name: "validate_feature", description: "d", parameters: {},
    async execute() { throw new Error("kaboom"); },
  }));
  const out = await boom.execute({}, { cwd: "/nonexistent-no-ledger" });
  assert.equal(out.isError, true);
  const shown = JSON.parse(out.content[0].text);
  assert.equal(shown.failure.owner, "bug");
  assert.match(shown.message, /kaboom/);

  const blocked = withFailureReporting(defineTool({
    name: "checkpoint_verified_task", description: "d", parameters: {},
    async execute() { return toolResult({ ok: false, reason: "CHECKPOINT_BLOCKED", message: "m" }); },
  }));
  const out2 = await blocked.execute({}, { cwd: "/nonexistent-no-ledger" });
  assert.equal(JSON.parse(out2.content[0].text).failure.code, "CHECKPOINT_BLOCKED");
});

test("converted extensions expose the same tool names and register through the adapter", () => {
  const names = (tools) => tools.map((t) => t.name);
  assert.deepEqual(names(createCheckpointTools(Type)), ["checkpoint_verified_task"]);
  assert.deepEqual(names(createFeatureValidationTools(Type)), ["validate_feature", "inspect_feature_validation"]);
  assert.deepEqual(names(createScaffoldTools(Type)), ["scaffold_tasks"]);
  assert.deepEqual(names([createReviewTool(Type)]), ["review_changes"]);
  const registered = [];
  registerPiTools({ registerTool: (t) => registered.push(t) }, [
    ...createCheckpointTools(Type), ...createScaffoldTools(Type), createReviewTool(Type),
  ]);
  assert.deepEqual(names(registered), ["checkpoint_verified_task", "scaffold_tasks", "review_changes"]);
  for (const tool of registered) {
    assert.equal(typeof tool.description, "string");
    assert.equal(tool.execute.length, 5, `${tool.name} must keep Pi's 5-argument execute`);
  }
});

// The point of the layer: nothing the next host (an MCP server) would load may depend on Pi.
async function sources(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { if (entry.name !== "node_modules") out.push(...await sources(full)); }
    else if (/\.mjs$/.test(entry.name)) out.push(full);
  }
  return out;
}

test("no host-neutral module imports a host SDK or touches the UI", async () => {
  const files = [...await sources(path.join(root, "lib")), ...await sources(path.join(root, "extensions"))];
  assert.ok(files.length > 50);
  const offenders = [];
  for (const file of files) {
    const text = await readFile(file, "utf8");
    if (/@earendil-works|@mariozechner|pi-coding-agent|@modelcontextprotocol|ExtensionAPI|\bctx\.ui\b|registerTool\(/.test(text)
      && path.relative(root, file) !== path.join("lib", "host", "pi.mjs")) offenders.push(path.relative(root, file));
  }
  // lib/host/pi.mjs is the one allowed Pi seam. Nothing else under lib/ or any *.mjs workflow may reach the host.
  assert.deepEqual(offenders, []);
});

test("Pi host confirm fails closed without a UI and passes the answer through with one", async () => {
  const signal = new AbortController().signal;
  let asked = 0;
  const ui = { confirm: async () => (asked++, true) };
  assert.equal(await piHost(signal, undefined, { cwd: "/r", hasUI: false, ui }).confirm("t", "m"), false);
  assert.equal(await piHost(signal, undefined, { cwd: "/r", ui }).confirm("t", "m"), false);
  assert.equal(await piHost(signal, undefined, { cwd: "/r" }).confirm("t", "m"), false);
  assert.equal(asked, 0, "a headless context must never reach the UI");
  assert.equal(await piHost(signal, undefined, { cwd: "/r", hasUI: true, ui }).confirm("t", "m"), true);
  assert.equal(await piHost(signal, undefined, { cwd: "/r", hasUI: true, ui: { confirm: async () => false } }).confirm("t", "m"), false);
  assert.equal(asked, 1);
});

test("the tool inventory is stable across hosts", async () => {
  const { createExecuteAndReviewTools } = await import("../pi/agent/extensions/execute-and-review/tools.mjs");
  const { createExecutionRecoveryTools } = await import("../pi/agent/extensions/execution-recovery/tools.mjs");
  const all = [
    ...createExecuteAndReviewTools(Type), ...createExecutionRecoveryTools(Type), ...createCheckpointTools(Type),
    ...createFeatureValidationTools(Type), ...createScaffoldTools(Type), createReviewTool(Type),
  ];
  assert.deepEqual(all.map((t) => t.name).sort(), [
    "adopt_foreign_commits", "approve_delivery_amendment", "approve_feature_direction", "checkpoint_verified_task",
    "execute_and_review", "inspect_conductor_evidence", "inspect_feature_drift", "inspect_feature_validation",
    "inspect_issue_attempt", "inspect_issue_handoff", "prepare_issue_handoff", "review_changes",
    "resume_issue", "rewrite_feature_history", "scaffold_tasks", "suspend_issue", "validate_feature",
  ].sort());
  assert.equal(new Set(all.map((t) => t.name)).size, all.length, "tool names are unique");
  for (const tool of all) {
    assert.ok(tool.label && tool.description.length > 40, `${tool.name} documents itself`);
    assert.equal(typeof tool.execute, "function");
  }
});

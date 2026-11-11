import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createMcpCaller, mcpToolList } from "../pi/agent/lib/host/mcp.mjs";
import { defineTool, toolResult } from "../pi/agent/lib/host/tool.mjs";

const schema = { type: "object", properties: { n: { type: "integer" } }, required: ["n"], additionalProperties: false };
const ok = () => true;

function spyTool(run = async (params) => toolResult({ ok: true, params })) {
  const calls = [];
  const tool = defineTool({
    name: "spy", label: "Spy", description: "A spy tool.", parameters: schema,
    async execute(params, host) { calls.push({ params, host }); return run(params, host); },
  });
  return { tool, calls };
}

test("tool list maps name, title, description and schema", () => {
  const { tool } = spyTool();
  assert.deepEqual(mcpToolList([tool]), [{ name: "spy", title: "Spy", description: "A spy tool.", inputSchema: schema }]);
  const { label: _label, ...unlabelled } = tool;
  assert.equal("title" in mcpToolList([unlabelled])[0], false);
});

test("a validator and cwd are mandatory, so an unvalidated call cannot be built", () => {
  const { tool } = spyTool();
  assert.throws(() => createMcpCaller([tool], { cwd: "/r" }), /validate/);
  assert.throws(() => createMcpCaller([tool], { validate: ok }), /cwd/);
  assert.throws(() => createMcpCaller([tool, tool], { cwd: "/r", validate: ok }), /Duplicate/);
});

test("invalid arguments are rejected before the tool runs", async () => {
  const { tool, calls } = spyTool();
  const call = createMcpCaller([tool], { cwd: "/r", validate: (_s, v) => (Number.isInteger(v.n) ? true : [{ instancePath: "/n", message: "must be integer" }]) });
  const result = await call("spy", { n: "x" });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Invalid arguments for spy: \/n must be integer/);
  assert.equal(calls.length, 0, "the tool must never see unvalidated input");
  assert.equal((await call("spy", { n: 1 })).isError, false);
  assert.equal(calls.length, 1);
});

test("distinct validation messages are shown once and capped", async () => {
  const { tool } = spyTool();
  const many = Array.from({ length: 30 }, (_, i) => ({ instancePath: "/p", message: i % 2 ? "must be A" : "must be B" }));
  const text = (await createMcpCaller([tool], { cwd: "/r", validate: () => many })("spy", {})).content[0].text;
  assert.equal(text, "Invalid arguments for spy: /p must be B; /p must be A");
  const wide = Array.from({ length: 12 }, (_, i) => ({ instancePath: `/p${i}`, message: "bad" }));
  assert.match((await createMcpCaller([tool], { cwd: "/r", validate: () => wide })("spy", {})).content[0].text, /\(\+4 more\)$/);
});

test("unknown tools and thrown errors come back as isError results", async () => {
  const { tool } = spyTool(async () => { throw new Error("boom"); });
  const call = createMcpCaller([tool], { cwd: "/r", validate: ok });
  assert.deepEqual(await call("missing", {}), { content: [{ type: "text", text: "Unknown tool: missing" }], isError: true });
  const result = await call("spy", { n: 1 });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /spy failed: boom/);
});

test("cwd and abort signal reach the tool; the result keeps the tool's text and isError", async () => {
  const { tool, calls } = spyTool(async () => toolResult({ ok: false, reason: "X" }));
  const signal = new AbortController().signal;
  const result = await createMcpCaller([tool], { cwd: "/repo", validate: ok })("spy", { n: 1 }, { signal });
  assert.equal(calls[0].host.cwd, "/repo");
  assert.equal(calls[0].host.signal, signal);
  assert.equal(result.isError, true);
  assert.deepEqual(JSON.parse(result.content[0].text), { ok: false, reason: "X" });
  assert.equal("details" in result, false);
});

test("confirm fails closed: no channel, a throwing channel and any non-true answer all refuse", async () => {
  let answer;
  const tool = defineTool({ name: "ask", description: "d", parameters: schema, execute: async (_p, host) => toolResult({ ok: true, approved: await host.confirm("t", "m") }) });
  const approved = async (confirm) => JSON.parse((await createMcpCaller([tool], { cwd: "/r", validate: ok, confirm })("ask", { n: 1 })).content[0].text).approved;
  assert.equal(await approved(undefined), false);
  assert.equal(await approved(async () => { throw new Error("channel down"); }), false);
  for (answer of ["yes", 1, {}, undefined, null, false]) assert.equal(await approved(async () => answer), false, `answer ${String(answer)}`);
  assert.equal(await approved(async () => true), true);
});

// ---- Protocol-level tests against the real server and SDK; skipped if `npm ci --prefix pi/mcp` has not run.
const installed = existsSync(new URL("../pi/mcp/node_modules/@modelcontextprotocol/sdk", import.meta.url));
const sdk = (p) => import(new URL(`../pi/mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/${p}`, import.meta.url));

async function connect(tools, { elicit } = {}) {
  const { createDeliveryServer } = await import("../pi/mcp/server.mjs");
  const { Client } = await sdk("client/index.js");
  const { InMemoryTransport } = await sdk("inMemory.js");
  const { ElicitRequestSchema } = await sdk("types.js");
  const client = new Client({ name: "test", version: "0" }, { capabilities: elicit ? { elicitation: {} } : {} });
  const asked = [];
  if (elicit) client.setRequestHandler(ElicitRequestSchema, async (request) => (asked.push(request.params), elicit(request.params)));
  const [a, b] = InMemoryTransport.createLinkedPair();
  const server = createDeliveryServer({ cwd: process.cwd(), tools });
  await Promise.all([server.connect(b), client.connect(a)]);
  return { client, asked, close: () => Promise.all([client.close(), server.close()]) };
}

const approvalTool = () => defineTool({
  name: "approve", description: "d", parameters: { type: "object", properties: {}, additionalProperties: false },
  execute: async (_p, host) => toolResult({ ok: true, approved: await host.confirm("Approve?", "scope") }),
});
const approvedBy = async (r) => JSON.parse(r.content[0].text).approved;

test("server lists all 17 delivery tools with real TypeBox schemas", { skip: !installed && "pi/mcp dependencies not installed" }, async (t) => {
  const { deliveryTools } = await import("../pi/mcp/server.mjs");
  const { client, close } = await connect(deliveryTools());
  t.after(close);
  const { tools } = await client.listTools();
  assert.equal(tools.length, 17);
  assert.equal(new Set(tools.map((x) => x.name)).size, 17);
  for (const x of tools) { assert.equal(x.inputSchema.type, "object", x.name); assert.ok(x.description.length > 40, x.name); }
  assert.ok(tools.some((x) => x.name === "approve_feature_direction"));
});

test("server validates arguments against the schema before any tool runs", { skip: !installed && "pi/mcp dependencies not installed" }, async (t) => {
  const { deliveryTools } = await import("../pi/mcp/server.mjs");
  const { client, close } = await connect(deliveryTools());
  t.after(close);
  const extra = await client.callTool({ name: "scaffold_tasks", arguments: { operation: "summary", feature_id: "F", extra: 1 } });
  assert.equal(extra.isError, true);
  assert.match(extra.content[0].text, /must NOT have additional properties/);
  const missing = await client.callTool({ name: "scaffold_tasks", arguments: { operation: "summary" } });
  assert.match(missing.content[0].text, /required property 'feature_id'/);
  const unknown = await client.callTool({ name: "nope", arguments: {} });
  assert.match(unknown.content[0].text, /Unknown tool/);
});

test("approval is asked through elicitation and only an explicit accept with approve=true counts", { skip: !installed && "pi/mcp dependencies not installed" }, async (t) => {
  for (const [reply, expected] of [
    [{ action: "accept", content: { approve: true } }, true],
    [{ action: "accept", content: { approve: false } }, false],
    [{ action: "accept", content: {} }, false],
    [{ action: "decline" }, false],
    [{ action: "cancel" }, false],
  ]) {
    const { client, asked, close } = await connect([approvalTool()], { elicit: async () => reply });
    t.after(close);
    assert.equal(await approvedBy(await client.callTool({ name: "approve", arguments: {} })), expected, JSON.stringify(reply));
    assert.equal(asked.length, 1);
    assert.match(asked[0].message, /Approve\?\n\nscope/);
  }
});

test("a client that cannot elicit can never approve", { skip: !installed && "pi/mcp dependencies not installed" }, async (t) => {
  const { client, close } = await connect([approvalTool()]);
  t.after(close);
  assert.equal(await approvedBy(await client.callTool({ name: "approve", arguments: {} })), false);
});

// ---- Launcher (start.mjs): the entry point hosts run.
test("launcher without dependencies exits 1 with a one-line fix on stderr and nothing on stdout", (t) => {
  // Reproduce the repo layout without node_modules: pi/mcp/{start.mjs,package.json} and the shared checker.
  const root = mkdtempSync(path.join(tmpdir(), "pi-mcp-nodeps-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, "pi/mcp"), { recursive: true });
  mkdirSync(path.join(root, "pi/agent/lib/host"), { recursive: true });
  for (const file of ["start.mjs", "package.json"]) copyFileSync(new URL(`../pi/mcp/${file}`, import.meta.url), path.join(root, "pi/mcp", file));
  copyFileSync(new URL("../pi/agent/lib/host/dependencies.mjs", import.meta.url), path.join(root, "pi/agent/lib/host/dependencies.mjs"));
  const run = spawnSync(process.execPath, [path.join(root, "pi/mcp/start.mjs")], { encoding: "utf8", timeout: 30000 });
  assert.equal(run.status, 1);
  assert.equal(run.stdout, "", "stdout is the MCP protocol channel and must stay clean");
  assert.match(run.stderr, /dependencies are not installed \(missing: @modelcontextprotocol\/sdk, ajv, typebox\)/);
  assert.match(run.stderr, /npm ci --prefix/);
  assert.doesNotMatch(run.stderr, /ERR_MODULE_NOT_FOUND|node:internal/, "no raw module-resolution stack trace");
});

test("launcher serves all 17 tools over real stdio", { skip: !installed && "pi/mcp dependencies not installed" }, async (t) => {
  const { Client } = await sdk("client/index.js");
  const { StdioClientTransport } = await sdk("client/stdio.js");
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL("../pi/mcp/start.mjs", import.meta.url))], cwd: process.cwd() });
  const client = new Client({ name: "test", version: "0" }, { capabilities: {} });
  t.after(() => client.close());
  await client.connect(transport);
  assert.equal((await client.listTools()).tools.length, 17);
});

// ---- Progress heartbeat: keeps long calls alive for clients that reset their timeout on progress (Pi).
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const slowTool = (ms) => defineTool({ name: "slow", description: "d", parameters: { type: "object", properties: {}, additionalProperties: false }, execute: async () => (await sleep(ms), toolResult({ ok: true })) });

test("heartbeat sends increasing progress while a tool runs and stops when it finishes", async () => {
  const seen = [];
  const call = createMcpCaller([slowTool(120)], { cwd: "/r", validate: ok, heartbeatMs: 15 });
  const result = await call("slow", {}, { progress: (n, message) => seen.push({ n, message }) });
  assert.equal(result.isError, false);
  assert.ok(seen.length >= 3, `expected several heartbeats, got ${seen.length}`);
  assert.deepEqual(seen.map((x) => x.n), seen.map((_, i) => i + 1), "progress must strictly increase");
  assert.match(seen[0].message, /^slow running \(\d+s\)$/);
  const after = seen.length;
  await sleep(60);
  assert.equal(seen.length, after, "no heartbeat after the call finished");
});

test("no heartbeat without a progress callback, and a failing notification never fails the call", async () => {
  const quiet = await createMcpCaller([slowTool(40)], { cwd: "/r", validate: ok, heartbeatMs: 5 })("slow", {});
  assert.equal(quiet.isError, false);
  let attempts = 0;
  const flaky = await createMcpCaller([slowTool(60)], { cwd: "/r", validate: ok, heartbeatMs: 10 })("slow", {}, { progress: () => { attempts++; throw new Error("client gone"); } });
  assert.ok(attempts > 0);
  assert.equal(flaky.isError, false, "a dead notification channel must not fail the tool");
});

test("heartbeat stops when the tool throws", async () => {
  const boom = defineTool({ name: "boom", description: "d", parameters: schema, execute: async () => { await sleep(30); throw new Error("x"); } });
  const seen = [];
  const result = await createMcpCaller([boom], { cwd: "/r", validate: ok, heartbeatMs: 5 })("boom", { n: 1 }, { progress: (n) => seen.push(n) });
  assert.equal(result.isError, true);
  const after = seen.length;
  await sleep(40);
  assert.equal(seen.length, after);
});

test("server relays heartbeats as MCP progress notifications when the client asks for progress", { skip: !installed && "pi/mcp dependencies not installed" }, async (t) => {
  const { createDeliveryServer } = await import("../pi/mcp/server.mjs");
  const { Client } = await sdk("client/index.js");
  const { InMemoryTransport } = await sdk("inMemory.js");
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" }, { capabilities: {} });
  const server = createDeliveryServer({ cwd: process.cwd(), tools: [slowTool(120)], heartbeatMs: 15 });
  await Promise.all([server.connect(b), client.connect(a)]);
  t.after(() => Promise.all([client.close(), server.close()]));
  const seen = [];
  await client.callTool({ name: "slow", arguments: {} }, undefined, { onprogress: (p) => seen.push(p) });
  assert.ok(seen.length >= 3, `expected progress notifications, got ${seen.length}`);
  assert.match(seen[0].message, /slow running/);
  const none = [];
  await client.callTool({ name: "slow", arguments: {} });
  assert.deepEqual(none, [], "without onprogress the client sends no token, so none are sent");
});

// ---- Interactive (approval) tools: stay native in Pi, are omitted from the Pi-facing MCP server.
test("exactly the three approval tools are marked interactive and MCP listings do not leak the flag", { skip: !installed && "pi/mcp dependencies not installed" }, async () => {
  const { deliveryTools } = await import("../pi/mcp/server.mjs");
  const all = deliveryTools();
  assert.deepEqual(all.filter((t) => t.interactive).map((t) => t.name).sort(),
    ["adopt_foreign_commits", "approve_delivery_amendment", "approve_feature_direction"]);
  const rest = deliveryTools({ includeInteractive: false });
  assert.equal(rest.length, 14);
  assert.equal(rest.some((t) => t.interactive), false);
  for (const entry of mcpToolList(all)) assert.equal("interactive" in entry, false, entry.name);
});

test("PI_DELIVERY_MCP_OMIT_INTERACTIVE=1 makes the served server omit the approval tools", { skip: !installed && "pi/mcp dependencies not installed" }, async (t) => {
  const { Client } = await sdk("client/index.js");
  const { StdioClientTransport } = await sdk("client/stdio.js");
  for (const [omit, expected] of [["1", 14], [undefined, 17]]) {
    const env = { ...process.env, ...(omit ? { PI_DELIVERY_MCP_OMIT_INTERACTIVE: omit } : {}) };
    if (!omit) delete env.PI_DELIVERY_MCP_OMIT_INTERACTIVE;
    const client = new Client({ name: "test", version: "0" }, { capabilities: {} });
    t.after(() => client.close());
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL("../pi/mcp/start.mjs", import.meta.url))], env, cwd: process.cwd() }));
    const names = (await client.listTools()).tools.map((x) => x.name);
    assert.equal(names.length, expected, `omit=${omit}`);
    assert.equal(names.includes("approve_feature_direction"), !omit);
  }
});

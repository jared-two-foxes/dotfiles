import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
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

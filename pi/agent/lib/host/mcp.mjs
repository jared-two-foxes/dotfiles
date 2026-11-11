// MCP adapter: presents host-neutral tools (./tool.mjs) as Model Context Protocol tools.
//
// Dependency-free on purpose: it neither imports the MCP SDK nor a JSON Schema validator. The server
// (pi/mcp/server.mjs) injects both, so this logic is unit-testable and the neutrality guard still holds.
//
// Two things Pi did for tools that an MCP server must do itself:
//   1. Validate arguments against the tool's schema before `execute`. The MCP SDK's low-level server
//      does not, and workflows rely on `additionalProperties: false` and required fields. `validate` is
//      therefore mandatory, and an unvalidated call can never reach a tool.
//   2. Answer `host.confirm`. It fails closed: no way to ask a human means `false`.
import { defineTool } from "./tool.mjs";

/** MCP `tools/list` entries. `inputSchema` is the tool's JSON Schema as-is. */
export function mcpToolList(tools) {
  return tools.map((tool) => {
    defineTool(tool);
    return {
      name: tool.name,
      ...(tool.label ? { title: tool.label } : {}),
      description: tool.description,
      inputSchema: tool.parameters,
    };
  });
}

const failed = (message) => ({ content: [{ type: "text", text: message }], isError: true });

// Union schemas report one error per branch; show each distinct message once and keep the reply short.
const describeErrors = (errors) => {
  const lines = [...new Set(errors.map((e) => (typeof e === "string" ? e : `${e.instancePath || "(root)"} ${e.message}`.trim())))];
  const shown = lines.slice(0, 8).join("; ");
  return lines.length > 8 ? `${shown}; (+${lines.length - 8} more)` : shown;
};

/**
 * Build `callTool(name, args, { signal })` returning an MCP CallToolResult.
 *
 * @param tools     host-neutral tools
 * @param options.cwd       working directory every tool runs in
 * @param options.validate  (schema, value) => true | array of errors. Required.
 * @param options.confirm   (title, message) => Promise<boolean>. Optional; absent means "cannot ask a human".
 * @param options.heartbeatMs  progress heartbeat interval while a tool runs (only if the call supplies `progress`).
 */
export function createMcpCaller(tools, { cwd, validate, confirm, heartbeatMs = 15000 } = {}) {
  if (typeof validate !== "function") throw new TypeError("createMcpCaller requires a validate(schema, value) function");
  if (typeof cwd !== "string" || !cwd) throw new TypeError("createMcpCaller requires cwd");
  const byName = new Map(tools.map((tool) => [defineTool(tool).name, tool]));
  if (byName.size !== tools.length) throw new Error("Duplicate tool names");

  const host = (signal) => ({
    cwd,
    signal,
    confirm: async (title, message) => {
      if (!confirm) return false;
      try {
        return (await confirm(title, message)) === true;
      } catch {
        return false; // a broken approval channel is a refusal, never an approval
      }
    },
  });

  // `progress(n, message)` is supplied only when the client asked for progress (it sent a progressToken).
  // While a tool runs we send a periodic heartbeat: clients such as Pi reset their request timeout on
  // progress, and delivery tools can run for many minutes. A failed notification never fails the call.
  const heartbeat = (name, progress, intervalMs) => {
    if (!progress) return () => {};
    let n = 0;
    const startedAt = Date.now();
    const timer = setInterval(() => {
      const message = `${name} running (${Math.round((Date.now() - startedAt) / 1000)}s)`;
      // Run inside the promise chain so a synchronous throw is swallowed too, not an uncaught exception.
      Promise.resolve().then(() => progress(++n, message)).catch(() => {});
    }, intervalMs);
    timer.unref?.();
    return () => clearInterval(timer);
  };

  return async function callTool(name, args, { signal, progress } = {}) {
    const tool = byName.get(name);
    if (!tool) return failed(`Unknown tool: ${name}`);
    const input = args ?? {};
    const verdict = validate(tool.parameters, input);
    if (verdict !== true && !(Array.isArray(verdict) && verdict.length === 0)) {
      return failed(`Invalid arguments for ${name}: ${describeErrors(Array.isArray(verdict) ? verdict : [String(verdict)])}`);
    }
    let result;
    const stop = heartbeat(name, progress, heartbeatMs);
    try {
      result = await tool.execute(input, host(signal));
    } catch (error) {
      // Delivery tools already convert exceptions into failure envelopes; this covers any that are not wrapped.
      return failed(`${name} failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      stop();
    }
    return {
      content: result.content,
      isError: result.isError === true,
      // `details` is the structured outcome. Kept off the wire as `structuredContent` because that field must
      // match a declared outputSchema, and these tools do not declare one; the text content carries the result.
    };
  };
}

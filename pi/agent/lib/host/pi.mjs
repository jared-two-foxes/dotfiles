// Pi adapter: presents host-neutral tools (./tool.mjs) to Pi's `registerTool`.
// This is the only place that knows Pi's `execute(toolCallId, params, signal, onUpdate, ctx)` shape.
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { missingDependencies } from "./dependencies.mjs";
import { defineTool } from "./tool.mjs";

export const MCP_SERVER_NAME = "pidelivery";

/**
 * Where Pi gets the delivery tools. `PI_DELIVERY_TRANSPORT=mcp` opts in to serving them over MCP
 * (pi/mcp); anything else, or an MCP server that cannot start, is the native in-process registration.
 * Both registration paths call this, so they always agree and Pi never ends up with no delivery tools.
 *
 * @returns {{ transport: "native" | "mcp", serverPath: string, warning?: string }}
 */
export function deliveryTransport({
  env = process.env,
  serverPath = env.PI_DELIVERY_MCP_SERVER || fileURLToPath(new URL("../../../mcp/start.mjs", import.meta.url)),
} = {}) {
  const requested = (env.PI_DELIVERY_TRANSPORT ?? "native").trim().toLowerCase() || "native";
  if (requested === "native") return { transport: "native", serverPath };
  if (requested !== "mcp") {
    return { transport: "native", serverPath, warning: `PI_DELIVERY_TRANSPORT=${requested} is not recognised (use "native" or "mcp"); using native delivery tools.` };
  }
  if (!existsSync(serverPath)) {
    return { transport: "native", serverPath, warning: `PI_DELIVERY_TRANSPORT=mcp but ${serverPath} does not exist; using native delivery tools. Set PI_DELIVERY_MCP_SERVER to its location.` };
  }
  let missing;
  try {
    missing = missingDependencies(path.dirname(serverPath));
  } catch (error) {
    return { transport: "native", serverPath, warning: `PI_DELIVERY_TRANSPORT=mcp but the MCP server could not be checked (${error.message}); using native delivery tools.` };
  }
  if (missing.length) {
    return { transport: "native", serverPath, warning: `PI_DELIVERY_TRANSPORT=mcp but the MCP server's dependencies are not installed (${missing.join(", ")}); using native delivery tools. Run: npm ci --prefix "${path.dirname(serverPath)}"` };
  }
  return { transport: "mcp", serverPath };
}

/**
 * The `mcpServers` entry Pi registers for the delivery server.
 *   exposure direct   Pi's default (codemode) hides tools from the model; delivery tools must be declared.
 *   timeout           Pi's 60 s default would cut off execute_and_review (workflows run up to 30 minutes).
 *   cwd "."           resolved by Pi against the session directory: the repository being delivered.
 *   OMIT_INTERACTIVE  Pi's MCP client cannot elicit, so the approval tools stay native (see registerPiTools).
 */
export function deliveryMcpServerConfig(serverPath) {
  return {
    command: "node",
    args: [serverPath],
    cwd: ".",
    env: { PI_DELIVERY_MCP_OMIT_INTERACTIVE: "1" },
    exposure: "direct",
    timeout: 3600,
    description: "Pi delivery pipeline: Scaffold task graph, execute_and_review, checkpoints, validation, recovery and review.",
  };
}

/**
 * Build the neutral `host` from Pi's execution context. `confirm` reaches the real UI lazily and fails
 * closed: with no UI (headless, print mode) it resolves false rather than approving.
 */
export function piHost(signal, onUpdate, ctx) {
  return {
    cwd: ctx.cwd,
    signal,
    onUpdate,
    confirm: async (title, message) => ctx.hasUI === true && Boolean(await ctx.ui.confirm(title, message)),
  };
}

export function toPiTool(tool) {
  defineTool(tool);
  const { execute, ...rest } = tool;
  return {
    ...rest,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      return execute(params, piHost(signal, onUpdate, ctx));
    },
  };
}

/**
 * Register tools natively. Over MCP only the `interactive` tools stay here: they need Pi's real UI for
 * `host.confirm`, and their approvals are written to the ledger, which every other tool reads back.
 */
export function registerPiTools(pi, tools, { transport = deliveryTransport().transport } = {}) {
  for (const tool of tools) {
    if (transport === "mcp" && !tool.interactive) continue;
    pi.registerTool(toPiTool(tool));
  }
}

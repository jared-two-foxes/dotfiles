// Pi adapter: presents host-neutral tools (./tool.mjs) to Pi's `registerTool`.
// This is the only place that knows Pi's `execute(toolCallId, params, signal, onUpdate, ctx)` shape.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { missingDependencies } from "./dependencies.mjs";
import { describeToolCall, piGuardVerdict } from "../guard/pi.mjs";
import { defineTool } from "./tool.mjs";

export const MCP_SERVER_NAME = "pidelivery";

// One real startup check per server per process: seven registrations in one Pi session must not spawn seven.
const startupChecks = new Map();

/**
 * Why `node <serverPath> --check` fails, or undefined if the server can start. This loads the full module
 * graph, so it also catches what the direct-dependency check cannot: a missing transitive dependency, a Node
 * too old for the SDK, a syntax error, or no `node` on PATH (Pi launches the server with plain `node`).
 */
function startupProblem(serverPath, env) {
  if (startupChecks.has(serverPath)) return startupChecks.get(serverPath);
  const run = spawnSync("node", [serverPath, "--check"], {
    encoding: "utf8", timeout: 30000, windowsHide: true, env: { ...process.env, ...env }, cwd: path.dirname(serverPath),
  });
  let problem;
  if (run.error?.code === "ENOENT") problem = "`node` was not found on PATH";
  else if (run.error?.code === "ETIMEDOUT") problem = "the startup check timed out";
  else if (run.error) problem = run.error.message;
  else if (run.status !== 0) {
    const line = (run.stderr ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean).find((l) => /error|cannot|missing|not installed/i.test(l))
      ?? (run.stderr ?? "").split(/\r?\n/).map((l) => l.trim()).find(Boolean);
    problem = line ? line.slice(0, 240) : `exit code ${run.status}`;
  }
  startupChecks.set(serverPath, problem);
  return problem;
}

/**
 * Where Pi gets the delivery tools. `PI_DELIVERY_TRANSPORT=mcp` opts in to serving them over MCP
 * (pi/mcp); anything else, or an MCP server that cannot start, is the native in-process registration.
 * Both registration paths call this, so they always agree. MCP is chosen only if the server was actually
 * started (`start.mjs --check`), so a server that cannot start never suppresses the native tools. A server that
 * dies later, mid-session, is not covered: Pi shows it disconnected and reconnects on the next call.
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
  const problem = startupProblem(serverPath, env);
  if (problem) {
    return { transport: "native", serverPath, warning: `PI_DELIVERY_TRANSPORT=mcp but the MCP server could not start (${problem}); using native delivery tools.` };
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
    // CLAUDE_PROJECT_DIR is blanked so a value inherited from a Claude Code shell cannot redirect the server.
    env: { PI_DELIVERY_MCP_OMIT_INTERACTIVE: "1", CLAUDE_PROJECT_DIR: "" },
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

/**
 * The delivery guard's `tool_call` handler: `pi.on("tool_call", createToolCallGuard())` (extensions/delivery-guard).
 *   deny -> { block: true, reason }       (the model reads the reason in the tool result and can adapt)
 *   ask  -> the user confirms in Pi's UI; no UI, a "no", a cancel or a crashed prompt all block
 *   pass -> undefined (Pi runs the tool; the guard never grants anything)
 * An unexpected error blocks the call: a guard that fails open is not a guard.
 */
export function createToolCallGuard({ env = process.env } = {}) {
  return async function toolCallGuard(event, ctx) {
    let verdict;
    try {
      verdict = piGuardVerdict(event, { cwd: ctx.cwd, env });
    } catch (error) {
      return { block: true, reason: `The delivery guard failed (${error?.message ?? error}); blocking the call.` };
    }
    if (verdict.decision === "pass") return undefined;
    if (verdict.decision === "deny") return { block: true, reason: verdict.reason };

    if (ctx.hasUI !== true) {
      return { block: true, reason: `${verdict.reason} Refused: there is no user interface to confirm it.` };
    }
    let confirmed = false;
    try {
      // Exactly `true` approves. piHost().confirm coerces with Boolean(), which would let a truthy non-boolean through.
      confirmed = (await ctx.ui.confirm("Confirm this action?", `${describeToolCall(event)}\n\n${verdict.reason}`)) === true;
    } catch { /* a broken prompt is a refusal */ }
    return confirmed ? undefined : { block: true, reason: `The user did not confirm this action. ${verdict.reason}` };
  };
}

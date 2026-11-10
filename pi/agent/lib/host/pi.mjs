// Pi adapter: presents host-neutral tools (./tool.mjs) to Pi's `registerTool`.
// This is the only place that knows Pi's `execute(toolCallId, params, signal, onUpdate, ctx)` shape.
import { defineTool } from "./tool.mjs";

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

export function registerPiTools(pi, tools) {
  for (const tool of tools) pi.registerTool(toPiTool(tool));
}

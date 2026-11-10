// Host-neutral tool contract.
//
// A tool is `{ name, label?, description, parameters, execute(params, host) }`.
//   parameters  a JSON Schema object (built with an injected TypeBox-style `Type`, so no host
//               package is imported here)
//   host        { cwd, signal?, onUpdate?, confirm?(title, message) -> Promise<boolean> }
//   execute     resolves to `toolResult(...)`: { content: [{type:"text", text}], isError, details }
//
// Nothing in this file or in a tool definition may import a host SDK. Hosts (Pi today, an MCP
// server next) adapt this shape in their own adapter; see ./pi.mjs.
import { reportFailures } from "../failure/tool.mjs";

/** Standard tool result: `details` as pretty JSON text. `isError` defaults to `!details.ok`. */
export function toolResult(details, { isError = !details?.ok, text = details } = {}) {
  return {
    content: [{ type: "text", text: JSON.stringify(text, null, 2) }],
    isError,
    details,
  };
}

const present = (value, what) => {
  if (value === undefined || value === null) throw new TypeError(`Tool definition is missing ${what}`);
};

/** Validate a definition's shape once, at definition time, so a typo fails at load rather than at call. */
export function defineTool(tool) {
  for (const field of ["name", "description", "parameters", "execute"]) present(tool?.[field], field);
  if (typeof tool.execute !== "function") throw new TypeError(`Tool ${tool.name}: execute must be a function`);
  return tool;
}

/**
 * Apply the shared failure envelope (code, owner, next; ledger recording) to a host-neutral tool.
 * Reuses `reportFailures` unchanged by presenting it a call shape it understands.
 */
export function withFailureReporting(tool, options = {}) {
  const wrapped = reportFailures(
    { name: tool.name, execute: (_id, params, _signal, _onUpdate, ctx) => tool.execute(params, ctx.host) },
    options,
  );
  return {
    ...tool,
    execute: (params, host) =>
      wrapped.execute(undefined, params, host.signal, host.onUpdate, { cwd: host.cwd, host }),
  };
}

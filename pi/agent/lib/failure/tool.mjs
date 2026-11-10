// Wrap a registered tool so every failure has the same shape, is recorded in the ledger, and an exception
// the tool did not handle becomes a failure the agent and a reviewer can read instead of a bare error.
import { exceptionEnvelope, failureEnvelope, isFailure, recordFailure } from "./report.mjs";

const textOf = (output) => output?.content?.find((c) => c?.type === "text")?.text;

function withFailure(output, envelope, recorded) {
  const failure = { ...envelope, recorded };
  const text = textOf(output);
  let content = output.content;
  try {
    const parsed = JSON.parse(text);
    content = [{ type: "text", text: JSON.stringify({ ...parsed, failure }, null, 2) }, ...output.content.filter((c) => c.text !== text)];
  } catch {
    content = [...(output.content ?? []), { type: "text", text: JSON.stringify({ failure }, null, 2) }];
  }
  return { ...output, content, details: { ...(output.details ?? {}), failure } };
}

/** `tool.execute` wrapped with failure reporting. Pass options.scaffoldOptions only from tests. */
export function reportFailures(tool, options = {}) {
  const execute = tool.execute;
  return {
    ...tool,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const directory = ctx?.cwd;
      let output;
      try {
        output = await execute.call(this, toolCallId, params, signal, onUpdate, ctx);
      } catch (error) {
        const envelope = exceptionEnvelope(tool.name, error);
        const recorded = await recordFailure(directory, params, envelope, options);
        return withFailure({ content: [{ type: "text", text: JSON.stringify({ ok: false, message: envelope.message }, null, 2) }], isError: true, details: { ok: false } }, envelope, recorded);
      }
      const result = output?.details;
      const envelope = failureEnvelope(tool.name, result);
      if (!envelope) return output;
      // A NEEDS_DESIGN attempt already left a receipt in the ledger; every other failure leaves nothing.
      const recorded = isFailure(result) ? await recordFailure(directory, params, envelope, options) : null;
      return withFailure(output, envelope, recorded);
    },
  };
}

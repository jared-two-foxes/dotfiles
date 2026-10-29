/** Native task persistence only. Pi reasons; Scaffold validates; Conductor executes. */
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { scaffoldTasks, compactMutation } from "./adapter.mjs";

const text = () => Type.String({ minLength: 1 });
const definition = {
  id: text(), title: text(), objective: text(),
  acceptance_criteria: Type.Array(text(), { minItems: 1 }),
  context: Type.Optional(Type.String()),
  constraints: Type.Optional(Type.Array(text())),
};
const task = Type.Object({ ...definition,
  origin: Type.Optional(Type.Object({ kind: Type.Union(["ticket", "design", "review", "discovery"].map(v => Type.Literal(v))), reference: text() }, { additionalProperties: false })),
  dependencies: Type.Optional(Type.Array(text(), { uniqueItems: true })),
}, { additionalProperties: false });
const feature = Type.Object({ ...definition, design_ref: text(), baseline: text(), branch: text() }, { additionalProperties: false });
const evidence = Type.Object({
  feature_id: text(), task_id: text(), result: Type.Literal("PASSED"),
  source: text(), reference: text(), summary: text(),
}, { additionalProperties: false });
// Keep the tool schema an object for Pi/provider function-tool compatibility.
// The adapter enforces operation-specific required/forbidden fields as well.
const parameters = Type.Object({
  operation: Type.Union((["init", "add", "list", "next", "start", "complete", "block", "fail", "retry", "decompose", "design-next", "design-record", "design-finish", "design-reopen", "checkpoint-record", "issue-resume", "summary", "issue", "select", "design-select"] as const).map(value => Type.Literal(value))),
  feature_id: text(),
  task_id: Type.Optional(text()),
  payload: Type.Optional(Type.Union([feature, Type.Array(task, { minItems: 1 }), evidence,
    Type.Object({ summary: text(), verification: text(), approval: text(), disposition: Type.Union([Type.Literal("leaf"), Type.Literal("decomposed")]) }, { additionalProperties: false }),
    Type.Object({ reason: text(), reference: Type.Optional(text()) }, { additionalProperties: false }),
    Type.Object({ commit: text(), reference: text() }, { additionalProperties: false }),
    Type.Object({ reference: text(), handoff: text() }, { additionalProperties: false })])),
  reason: Type.Optional(text()),
}, { additionalProperties: false });

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "scaffold_tasks",
    label: "Scaffold Issues",
    description: "Perform ONE explicit Scaffold task lifecycle operation in Pi's current repository. " +
      "Persists task state only; never implements, verifies, invokes Conductor or automatically advances work. " +
      "Completion records externally obtained task-bound PASSED evidence; Scaffold does not authenticate it. " +
      "Use summary for phase/counts; issue for one scoped context; select/design-select for eligible scoped work. list is an explicit full-state diagnostic. Null selection never implies completion.",
    parameters,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const scopedParams = { ...params, operation: params.operation === "next" ? "select" : params.operation === "design-next" ? "design-select" : params.operation };
      const result = await scaffoldTasks(scopedParams, { directory: ctx.cwd, abort: signal });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(compactMutation(result), null, 2) }],
        isError: !result.ok,
        details: compactMutation(result),
      };
    },
  });
}

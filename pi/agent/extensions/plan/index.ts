/**
 * Plan writer for pi.
 *
 * Registers a single `write_plan` tool that writes a structured
 * implementation plan as markdown to .pi/plan.md in the current working
 * directory. Split out of the pi-linear extension so the Linear tools and
 * the plan-file writer can evolve independently — the two concerns have
 * nothing to do with each other beyond having originally been colocated.
 *
 * The companion agent is otherwise read-only (see SYSTEM.md); writing
 * .pi/plan.md is its one allowed local mutation, used to hand a plan off
 * to an implementer agent.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";

// Type-only — erased at runtime by jiti, no package resolution needed.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "write_plan",
    label: "Write Plan",
    description:
      "Write a structured implementation plan as markdown to .pi/plan.md " +
      "in the current working directory. This is the ONLY file you may " +
      "create or modify. Use this to hand off plans to an implementer agent.",
    parameters: Type.Object({
      content: Type.String({ description: "Markdown content of the plan" }),
    }),
    async execute(_toolCallId, params) {
      const planDir = join(process.cwd(), ".pi");
      mkdirSync(planDir, { recursive: true });
      writeFileSync(join(planDir, "plan.md"), params.content, "utf-8");
      return {
        content: [{
          type: "text" as const,
          text: `Plan written to .pi/plan.md (${params.content.length} chars)`,
        }],
      };
    },
  });
}
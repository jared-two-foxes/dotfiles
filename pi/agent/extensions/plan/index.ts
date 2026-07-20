/**
 * Plan and ticket file writers for pi.
 *
 * Registers two tools:
 *
 *   write_plan          -- writes a structured implementation plan as
 *                          markdown to .pi/plan.md in the current working
 *                          directory. The companion agent's one allowed
 *                          local mutation for handing off plans to an
 *                          implementer agent.
 *
 *   write_ticket_file   -- writes a scaffold-compatible ticket as a
 *                          markdown file in the current working directory,
 *                          for use with `scaffold push-ticket
 *                          --ticket-file-in`. Used by the to_tickets skill
 *                          to materialise tickets synthesised from
 *                          unstructured context (conversation transcripts,
 *                          design notes, ad-hoc observations) as local
 *                          files that can be pushed straight into the
 *                          criteria-stack pipeline without going through
 *                          Linear first.
 *
 * Split out of the pi-linear extension so the Linear tools and the
 * file-writer tools can evolve independently.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve, normalize, sep } from "node:path";
import { Type } from "typebox";

// Type-only — erased at runtime by jiti, no package resolution needed.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Pattern that validates a ticket's acceptance-criteria section: checks
// that the '## Acceptance Criteria' heading is present and is followed
// by at least one '- [ ] ...' checkbox bullet. [\s\S]*? is intentionally
// broad — a ticket body may include a short paragraph between the heading
// and the first criterion, so we only require that the checkbox appears
// somewhere after the heading, not immediately adjacent to it.
const ACCEPTANCE_CRITERIA_PATTERN = /## Acceptance Criteria[\s\S]*?- \[ \] /;

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

  pi.registerTool({
    name: "write_ticket_file",
    label: "Write Ticket File",
    description:
      "Write a scaffold-compatible ticket as a markdown file in the current " +
      "working directory. The file must contain a '## Acceptance Criteria' " +
      "section with '- [ ] ...' checkbox bullets so it can be pushed into " +
      "the scaffold TDD pipeline via: " +
      "scaffold push-ticket <id> --ticket-file-in <filename>. " +
      "Use this when the to_tickets skill has synthesised a ticket from " +
      "unstructured context and needs to materialise it as a local file.",
    parameters: Type.Object({
      filename: Type.String({
        description:
          "Filename for the ticket file, e.g. .ticket-adhoc-cache-fix.md. " +
          "Must end in .md and must not contain path separators or '..' components.",
      }),
      content: Type.String({
        description:
          "Full markdown content of the ticket. Must include a " +
          "'## Acceptance Criteria' section with '- [ ] ...' checkbox bullets.",
      }),
    }),
    async execute(_toolCallId, params) {
      const { filename, content } = params;

      if (!filename.endsWith(".md")) {
        return {
          content: [{
            type: "text" as const,
            text: "Error: filename must end in .md",
          }],
          isError: true,
        };
      }
      // Verify the resolved path is directly inside cwd. process.cwd()
      // never returns a trailing separator, so `cwd + sep` is a clean
      // directory prefix: `/project/` (not `/project`). This correctly
      // allows any file directly in cwd (resolved = cwd + sep + name) and
      // rejects both same-level path-prefix collisions (/project-evil/) and
      // upward traversal (../sibling/). The .md guard above already prevents
      // the only edge case where resolved would equal cwd itself (empty stem).
      const cwd = process.cwd();
      const resolved = resolve(cwd, normalize(filename));
      if (!resolved.startsWith(cwd + sep)) {
        return {
          content: [{
            type: "text" as const,
            text: "Error: filename must not traverse outside the working directory.",
          }],
          isError: true,
        };
      }
      // Validate that the '## Acceptance Criteria' heading is present and
      // is followed by at least one '- [ ] ...' checkbox bullet (see
      // ACCEPTANCE_CRITERIA_PATTERN above for the rationale).
      if (!ACCEPTANCE_CRITERIA_PATTERN.test(content)) {
        return {
          content: [{
            type: "text" as const,
            text:
              "Error: content must include a '## Acceptance Criteria' section " +
              "with at least one '- [ ] ...' checkbox bullet for scaffold " +
              "pipeline compatibility.",
          }],
          isError: true,
        };
      }

      writeFileSync(resolved, content, "utf-8");
      return {
        content: [{
          type: "text" as const,
          text:
            `Written: ${filename} (${content.length} chars)\n` +
            `Next: scaffold push-ticket <id> --ticket-file-in ${filename}`,
        }],
      };
    },
  });
}

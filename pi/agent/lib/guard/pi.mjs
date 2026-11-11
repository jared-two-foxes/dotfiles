// Pi adapter for the delivery guard: maps Pi's `tool_call` event onto the host-neutral policy (./index.mjs).
//
// Pi's built-in tools are read, bash, powershell, edit, write, grep, find and ls. Only bash, powershell, edit and
// write can change anything, so only those are policed. Pi hands the guard `{ toolName, input }` (edit and write
// take `path`, not `file_path`), resolves relative paths against the session directory and strips a leading `@`;
// this adapter does the same so the guard sees the file a call will really touch.
//
// Pure mapping only: it never touches Pi's UI. The handler that does (confirmation prompts) is
// createToolCallGuard in ../host/pi.mjs, the one module allowed to know Pi's context.
import path from "node:path";
import { GUARD_HINT, decide, guardActive } from "./index.mjs";

const PASS = { decision: "pass" };

// Pi's own planning tool writes any `*.md` name in the working directory, which would overwrite README.md. While a
// delivery is active it may only write the `.ticket-*.md` names its description recommends. (`write_plan` writes
// the fixed path .pi/plan.md and is left alone.)
const TICKET_NAME = /^\.ticket-[A-Za-z0-9._-]+\.md$/;

const resolveTarget = (raw, cwd) =>
  typeof raw === "string" && raw ? path.resolve(cwd, raw.replace(/^@/, "")) : undefined;

/** @returns {{ decision: "pass" } | { decision: "ask" | "deny", reason: string }} */
export function piGuardVerdict(event, { cwd, env = process.env } = {}) {
  const name = event?.toolName;
  const input = event?.input ?? {};
  switch (name) {
    case "bash":
      return decide({ tool_name: "Bash", tool_input: { command: input.command }, cwd }, { env });
    case "powershell":
      return decide({ tool_name: "PowerShell", tool_input: { command: input.command }, cwd }, { env });
    case "edit":
    case "write":
      return decide({ tool_name: name === "edit" ? "Edit" : "Write", tool_input: { file_path: resolveTarget(input.path, cwd) }, cwd }, { env });
    case "write_ticket_file":
      if (!guardActive({ cwd, env }) || TICKET_NAME.test(String(input.filename ?? ""))) return PASS;
      return {
        decision: "deny",
        reason: `write_ticket_file may only write ".ticket-<name>.md" while a Scaffold delivery is active (it would otherwise overwrite ` +
          `any .md file, such as README.md). ${GUARD_HINT}`,
      };
    default:
      return PASS;
  }
}

/** A one-line description of the call, for a confirmation prompt. */
export function describeToolCall(event) {
  return event?.toolName === "bash" || event?.toolName === "powershell"
    ? String(event.input?.command ?? "")
    : `${event?.toolName} ${event?.input?.path ?? ""}`.trim();
}

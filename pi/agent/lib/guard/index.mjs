// Delivery guard policy: host-neutral, no SDK imports. A host adapter (pi/claude/guard.mjs for Claude Code)
// feeds it a tool call and acts on the verdict. It only restricts; it never grants permission.
//
// Active only in a repository with a Scaffold delivery in progress (`.scaffold/features/<feature>.<id>/`),
// so ordinary repositories are untouched.
//   PI_DELIVERY_GUARD=auto (default)  enforce where a delivery is active
//   PI_DELIVERY_GUARD=on              enforce everywhere
//   PI_DELIVERY_GUARD=off             disabled (set by the user in their own environment; exactly "off" only)
import { readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { GUARD_HINT, posixShellVerdict, powershellVerdict } from "./shell.mjs";

export { GUARD_HINT, posixShellVerdict, powershellVerdict, tokenize } from "./shell.mjs";

const PASS = { decision: "pass" };
const FILE_TOOLS = new Set(["Edit", "Write", "NotebookEdit", "MultiEdit"]);
const POSIX_SHELL_TOOLS = new Set(["Bash", "Monitor"]);

function hasFeatures(dir) {
  try { return readdirSync(dir).length > 0; } catch { return false; }
}

/**
 * The directory holding an active delivery, found by walking up from `start` to the repository root,
 * or null. Never throws: an unreadable tree is "no delivery here".
 */
export function deliveryRoot(start) {
  if (typeof start !== "string" || !start) return null;
  try {
    let dir = path.resolve(start);
    for (let i = 0; i < 64; i++) {
      if (hasFeatures(path.join(dir, ".scaffold", "features"))) return dir;
      if (existsSync(path.join(dir, ".git"))) return null; // reached the repository root with no delivery
      const parent = path.dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  } catch { /* fall through */ }
  return null;
}

export function guardMode(env = process.env) {
  const mode = String(env.PI_DELIVERY_GUARD ?? "auto").trim().toLowerCase();
  return mode === "off" || mode === "on" ? mode : "auto";
}

/**
 * @param event  Claude Code PreToolUse input: { tool_name, tool_input, cwd }
 * @returns {{ decision: "pass" } | { decision: "ask" | "deny", reason: string }}
 */
export function decide(event, { env = process.env } = {}) {
  const tool = event?.tool_name;
  const input = event?.tool_input ?? {};
  const mode = guardMode(env);
  if (mode === "off") return PASS;

  const isFile = FILE_TOOLS.has(tool);
  const isShell = POSIX_SHELL_TOOLS.has(tool) || tool === "PowerShell";
  if (!isFile && !isShell) return PASS;

  let active = mode === "on";
  if (!active) {
    const cwd = event?.cwd ?? env.CLAUDE_PROJECT_DIR ?? process.cwd();
    active = deliveryRoot(cwd) !== null;
    // A file tool names its target: editing another repository's delivery from here counts too.
    const target = input.file_path ?? input.notebook_path;
    if (!active && isFile && typeof target === "string") active = deliveryRoot(path.dirname(target)) !== null;
  }
  if (!active) return PASS;

  if (isFile) {
    const target = input.file_path ?? input.notebook_path ?? "(unknown file)";
    return {
      decision: "deny",
      reason: `${tool} on ${target} is blocked: a Scaffold delivery is active in this repository, so source is changed only ` +
        `through the delivery tools (execute_and_review), which build, test and review each change. ${GUARD_HINT}`,
    };
  }
  return tool === "PowerShell" ? powershellVerdict(input.command) : posixShellVerdict(input.command);
}

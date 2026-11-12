// Delivery guard policy: host-neutral, no SDK imports. A host adapter (pi/claude/guard.mjs for Claude Code)
// feeds it a tool call and acts on the verdict. It only restricts; it never grants permission.
//
// Active only in a repository with a Scaffold delivery in progress (`.scaffold/features/<feature>.<id>/`),
// so ordinary repositories are untouched.
//   PI_DELIVERY_GUARD=auto (default)  enforce where a delivery is active
//   PI_DELIVERY_GUARD=on              enforce everywhere
//   PI_DELIVERY_GUARD=off             disabled (set by the user in their own environment; exactly "off" only)
import { existsSync, lstatSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import path from "node:path";
import { GUARD_HINT, posixShellVerdict, powershellVerdict } from "./shell.mjs";

export { GUARD_HINT, posixShellVerdict, powershellVerdict, tokenize } from "./shell.mjs";

const PASS = { decision: "pass" };
const FILE_TOOLS = new Set(["Edit", "Write", "NotebookEdit", "MultiEdit"]);
const POSIX_SHELL_TOOLS = new Set(["Bash", "Monitor"]);

/**
 * The real location of `p`: symlinks followed in every component, including a final one that dangles, with a
 * not-yet-existing remainder kept as written. Tools that write follow links, so "is this inside an active delivery"
 * must be asked of where the write will LAND, not of how the path was spelled. Never throws.
 */
export function canonicalPath(p) {
  let current = path.resolve(String(p));
  const rest = [];
  for (let hops = 0; hops < 64; hops++) {
    try { return path.join(realpathSync(current), ...[...rest].reverse()); } catch { /* not fully resolvable yet */ }
    try {
      if (lstatSync(current).isSymbolicLink()) { // a dangling link: continue from where it points
        current = path.resolve(path.dirname(current), readlinkSync(current));
        continue;
      }
    } catch { /* does not exist */ }
    const parent = path.dirname(current);
    if (parent === current) break;
    rest.push(path.basename(current));
    current = parent;
  }
  return path.resolve(String(p));
}

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
    let dir = canonicalPath(start); // a symlinked working directory must not hide the delivery it sits in
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

/** Whether the guard applies to `cwd` (and optionally a file `target` elsewhere). Honors PI_DELIVERY_GUARD. */
export function guardActive({ cwd, target, env = process.env } = {}) {
  const mode = guardMode(env);
  if (mode === "off") return false;
  if (mode === "on") return true;
  if (deliveryRoot(cwd ?? env.CLAUDE_PROJECT_DIR ?? process.cwd()) !== null) return true;
  // A file tool names its target: touching another repository's active delivery counts too, whether the
  // delivery is reached by the spelled path or only where a symlink in it (even the file itself) really leads.
  if (typeof target !== "string") return false;
  return deliveryRoot(path.dirname(target)) !== null || deliveryRoot(path.dirname(canonicalPath(target))) !== null;
}

/**
 * @param event  Claude Code PreToolUse input: { tool_name, tool_input, cwd }
 * @returns {{ decision: "pass" } | { decision: "ask" | "deny", reason: string }}
 */
export function decide(event, { env = process.env } = {}) {
  const tool = event?.tool_name;
  const input = event?.tool_input ?? {};
  if (guardMode(env) === "off") return PASS;

  const isFile = FILE_TOOLS.has(tool);
  const isShell = POSIX_SHELL_TOOLS.has(tool) || tool === "PowerShell";
  if (!isFile && !isShell) return PASS;

  const target = input.file_path ?? input.notebook_path;
  const active = guardActive({ cwd: event?.cwd, target: isFile ? target : undefined, env });
  if (!active) return PASS;

  if (isFile) {
    const shown = target ?? "(unknown file)";
    return {
      decision: "deny",
      reason: `${tool} on ${shown} is blocked: a Scaffold delivery is active in this repository, so source is changed only ` +
        `through the delivery tools (execute_and_review), which build, test and review each change. ${GUARD_HINT}`,
    };
  }
  return tool === "PowerShell" ? powershellVerdict(input.command) : posixShellVerdict(input.command);
}

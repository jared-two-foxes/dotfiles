// Pi adapter for the delivery guard: maps Pi's `tool_call` event onto the host-neutral policy (./index.mjs).
//
// Pi's built-in tools are read, bash, powershell, edit, write, grep, find and ls. Only bash, powershell, edit and
// write can change anything, so only those are policed. Pi hands the guard `{ toolName, input }` (edit and write
// take `path`, not `file_path`), resolves relative paths against the session directory and strips a leading `@`;
// this adapter does the same so the guard sees the file a call will really touch.
//
// Pure mapping only: it never touches Pi's UI. The handler that does (confirmation prompts) is
// createToolCallGuard in ../host/pi.mjs, the one module allowed to know Pi's context.
import { lstatSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GUARD_HINT, decide, guardActive } from "./index.mjs";

const PASS = { decision: "pass" };

// Pi's own planning tool writes any `*.md` name in the working directory, which would overwrite README.md. While a
// delivery is active it may only write the `.ticket-*.md` names its description recommends. (`write_plan` writes
// the fixed path .pi/plan.md and is left alone.)
const TICKET_NAME = /^\.ticket-[A-Za-z0-9._-]+\.md$/;

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

// Git Bash / MSYS / Cygwin / WSL drive paths, as Pi converts them on Windows.
function windowsShellPath(p) {
  if (!p.startsWith("/") || p.startsWith("//") || p.includes("\\")) return p;
  const m = p.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
  return m ? `${m[1].toUpperCase()}:\\${m[2]?.replaceAll("/", "\\") ?? ""}` : p;
}

/**
 * The file a Pi `edit`/`write` will really touch. This mirrors Pi's own resolver (utils/paths.js `normalizePath` +
 * `resolvePath`), step for step and in the same order, because a spelling the guard reads differently from Pi is a
 * bypass: Unicode spaces become ASCII, one leading `@` is stripped, `~` and `~/...` expand to the home directory,
 * `file://` URLs become paths, and a relative result is resolved against the session directory.
 * A `file://` URL that is not a local path throws; the handler turns that into a block.
 */
export function resolvePiPath(input, cwd, { home = os.homedir(), platform = process.platform } = {}) {
  let p = String(input).replace(UNICODE_SPACES, " ");
  if (p.startsWith("@")) p = p.slice(1);
  if (platform === "win32") p = windowsShellPath(p);
  if (p === "~") p = home;
  else if (p.startsWith("~/") || (platform === "win32" && p.startsWith("~\\"))) p = path.join(home, p.slice(2));
  else if (/^file:\/\//.test(p)) p = fileURLToPath(p);
  return path.isAbsolute(p) ? path.resolve(p) : path.resolve(cwd, p);
}

const resolveTarget = (raw, cwd, options) => (typeof raw === "string" && raw ? resolvePiPath(raw, cwd, options) : undefined);

/**
 * True if writing `rel` (relative to `cwd`) would go through a link. Planning tools write with `writeFileSync`, which
 * follows symlinks, so a committed `.ticket-x.md -> README.md` (or a `.pi -> src` directory link) would overwrite a
 * source file under a name the filename check accepts. A hard link to another file does the same. Each existing
 * component below `cwd` is checked, so a link anywhere on the way counts.
 */
function writesThroughLink(cwd, rel) {
  const dest = path.resolve(cwd, rel);
  let current = path.resolve(cwd);
  let stat;
  for (const part of path.relative(current, dest).split(path.sep)) {
    current = path.join(current, part);
    try { stat = lstatSync(current); } catch { return false; } // nothing there yet, so nothing to follow
    if (stat.isSymbolicLink()) return true;
  }
  return Boolean(stat?.isFile() && stat.nlink > 1);
}

const linkDenied = (tool, target) => ({
  decision: "deny",
  reason: `${tool} would write ${target} through a link (a symlink or hard link), which could overwrite a source file under an ` +
    `accepted name. ${GUARD_HINT}`,
});

/** @returns {{ decision: "pass" } | { decision: "ask" | "deny", reason: string }} */
export function piGuardVerdict(event, { cwd, env = process.env, home, platform } = {}) {
  const options = { home: home ?? os.homedir(), platform: platform ?? process.platform };
  const name = event?.toolName;
  const input = event?.input ?? {};
  switch (name) {
    case "bash":
      return decide({ tool_name: "Bash", tool_input: { command: input.command }, cwd }, { env });
    case "powershell":
      return decide({ tool_name: "PowerShell", tool_input: { command: input.command }, cwd }, { env });
    case "edit":
    case "write":
      return decide({ tool_name: name === "edit" ? "Edit" : "Write", tool_input: { file_path: resolveTarget(input.path, cwd, options) }, cwd }, { env });
    case "write_ticket_file": {
      if (!guardActive({ cwd, env })) return PASS;
      const filename = String(input.filename ?? "");
      if (!TICKET_NAME.test(filename)) {
        return {
          decision: "deny",
          reason: `write_ticket_file may only write ".ticket-<name>.md" while a Scaffold delivery is active (it would otherwise overwrite ` +
            `any .md file, such as README.md). ${GUARD_HINT}`,
        };
      }
      return writesThroughLink(cwd, filename) ? linkDenied("write_ticket_file", filename) : PASS;
    }
    case "write_plan":
      return guardActive({ cwd, env }) && writesThroughLink(cwd, path.join(".pi", "plan.md")) ? linkDenied("write_plan", ".pi/plan.md") : PASS;
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

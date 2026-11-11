/**
 * Enforces SYSTEM.md's "never edit source directly" rule instead of only asking for it.
 *
 * While a Scaffold delivery is active in the repository (a `.scaffold/features/<feature>.<id>/` directory), Pi's
 * `edit` and `write` are blocked and `bash`/`powershell` are limited to read-only commands; git/gh publishing asks
 * the user to confirm; merges, force-pushes and running the delivery CLIs directly are blocked. Elsewhere it does
 * nothing. Set PI_DELIVERY_GUARD=off to disable it (exactly "off"). Policy: lib/guard/. Detection of anything that
 * slips past is the ledger's job (checkpointHistory).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createToolCallGuard } from "../../lib/host/pi.mjs";

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", createToolCallGuard());
}

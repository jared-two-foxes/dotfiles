/**
 * Opt-in: serve the delivery tools to Pi through the MCP server (pi/mcp) instead of registering them
 * in-process. Enable with PI_DELIVERY_TRANSPORT=mcp. Off, or when the server cannot start, Pi keeps the
 * native tools. The approval tools always stay native (Pi's MCP client cannot elicit); see lib/host/pi.mjs.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { MCP_SERVER_NAME, deliveryMcpServerConfig, deliveryTransport } from "../../lib/host/pi.mjs";

export default function (pi: ExtensionAPI) {
  const choice = deliveryTransport();
  if (choice.transport === "mcp") pi.registerMcpServer(MCP_SERVER_NAME, deliveryMcpServerConfig(choice.serverPath));
  if (choice.warning) {
    pi.on("session_start", async (_event, ctx) => {
      if (ctx.hasUI) ctx.ui.notify(choice.warning!, "warning");
    });
  }
}

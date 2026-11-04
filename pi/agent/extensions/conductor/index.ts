import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { decodeRunner, runConductor } from "./client.mjs";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("conductor", {
    description: "Run a Conductor v2 request file",
    handler: async (args, ctx) => {
      const filename = args.trim();
      if (!filename) {
        ctx.ui.notify("Usage: /conductor <request-file>", "warning");
        return;
      }
      try {
        const input = await readFile(path.resolve(ctx.cwd, filename), "utf8");
        const request = JSON.parse(input);
        if (request?.schema !== "conductor.request/v2" || !Array.isArray(request.commands)) {
          throw new Error("Expected a Conductor v2 request with a commands array");
        }
        const result = decodeRunner(request, await runConductor(input, { cwd: ctx.cwd }));
        const details = [result.error, result.output_directory].filter(Boolean).join("\n");
        ctx.ui.notify(
          `Conductor ${result.status} (${result.phase})${details ? "\n" + details : ""}`,
          result.status === "PASSED" ? "info" : "warning",
        );
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
}

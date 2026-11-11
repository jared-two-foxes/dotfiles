#!/usr/bin/env node
// Entry point for MCP hosts. Checks that dependencies are installed before loading the server, because
// server.mjs has static imports and would otherwise die with an unreadable module-resolution stack trace.
// Messages go to stderr: stdout belongs to the MCP protocol.
import { fileURLToPath } from "node:url";
import { missingDependencies } from "../agent/lib/host/dependencies.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const missing = missingDependencies(here);

if (missing.length) {
  process.stderr.write(
    `pi-delivery-mcp: dependencies are not installed (missing: ${missing.join(", ")}).\n` +
      `Run once:  npm ci --prefix "${here.replace(/[\\/]$/, "")}"\n` +
      `(or run install/mcp.ps1, which the Windows installers call).\n`,
  );
  process.exit(1);
}

const { main } = await import("./server.mjs");
await main();

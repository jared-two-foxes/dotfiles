#!/usr/bin/env node
// Entry point for MCP hosts. Checks that dependencies are installed before loading the server, because
// server.mjs has static imports and would otherwise die with an unreadable module-resolution stack trace.
// Messages go to stderr: stdout belongs to the MCP protocol.
// `node start.mjs --check` exits 0 if the server could start, without serving.
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
// `--check` loads the whole server module graph (SDK, ajv, typebox, every delivery tool) and stops, so a
// caller can learn whether the server can start without running it. Pi uses this before choosing MCP.
if (process.argv.includes("--check")) process.exit(0);
await main();

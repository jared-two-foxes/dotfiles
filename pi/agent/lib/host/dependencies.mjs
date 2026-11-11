// Which of a package's declared dependencies are not installed. No imports beyond node: built-ins, so it
// can run before anything else is installed (the MCP launcher and Pi's transport check both use it).
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export function missingDependencies(packageDir) {
  const { dependencies = {} } = JSON.parse(readFileSync(path.join(packageDir, "package.json"), "utf8"));
  return Object.keys(dependencies).filter(
    (name) => !existsSync(path.join(packageDir, "node_modules", ...name.split("/"), "package.json")),
  );
}

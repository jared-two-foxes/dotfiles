import { watch } from "node:fs";
import path from "node:path";
import { git } from "./tree.mjs";
export function monitorTrackedInputs(repository) {
  const files = git(repository, ["ls-files", "-z"]).split("\0").filter(Boolean);
  const watchers = [];
  let changed = false;
  try {
    const tracked = new Set(files.map((f) => path.resolve(repository, f)));
    for (const dir of new Set(
      files.map((f) => path.dirname(path.resolve(repository, f))),
    )) {
      const watcher = watch(dir, (_event, name) => {
        if (!name || tracked.has(path.resolve(dir, name.toString())))
          changed = true;
      });
      watcher.on("error", () => {
        changed = true;
      });
      watchers.push(watcher);
    }
  } catch (error) {
    watchers.forEach((w) => w.close());
    throw error;
  }
  return {
    assert: () => {
      if (changed) throw new Error("Tracked implementation inputs changed during validation; reconcile");
    },
    close: () => watchers.forEach((w) => w.close()),
  };
}

import { watch } from "node:fs";
import path from "node:path";
import { git } from "./tree.mjs";
const MAX_EVENTS = 20;
// Any notification on a tracked path (or one that names no path) still trips the monitor, because a
// write-then-revert is invisible to the Git fingerprint. The offending events are recorded so a trip
// can be told apart as a real edit, a touch/antivirus metadata event, or an unnamed overflow.
export function monitorTrackedInputs(repository) {
  const files = git(repository, ["ls-files", "-z"]).split("\0").filter(Boolean);
  const watchers = [];
  const events = [];
  let total = 0;
  const record = (kind, dir, name) => {
    total++;
    if (events.length >= MAX_EVENTS) return;
    const file = name ? path.relative(repository, path.resolve(dir, name.toString())) : null;
    events.push({ kind, path: file ? file.split(path.sep).join("/") : null,
      dir: path.relative(repository, dir).split(path.sep).join("/") || ".", at: new Date().toISOString() });
  };
  try {
    const tracked = new Set(files.map((f) => path.resolve(repository, f)));
    for (const dir of new Set(
      files.map((f) => path.dirname(path.resolve(repository, f))),
    )) {
      const watcher = watch(dir, (event, name) => {
        if (!name) record("unnamed:" + event, dir, null);
        else if (tracked.has(path.resolve(dir, name.toString()))) record(event, dir, name);
      });
      watcher.on("error", (error) => {
        record("watcher-error:" + (error?.code ?? error?.message ?? "unknown"), dir, null);
      });
      watchers.push(watcher);
    }
  } catch (error) {
    watchers.forEach((w) => w.close());
    throw error;
  }
  return {
    events: () => events.slice(),
    assert: () => {
      if (!total) return;
      const first = events[0];
      const detail = events.slice(0, 3).map((e) => `${e.kind} ${e.path ?? "<unnamed in " + e.dir + ">"} @${e.at}`).join("; ");
      throw new Error("Tracked implementation inputs changed during validation; reconcile" +
        ` (${total} notification${total === 1 ? "" : "s"}, first ${first.kind} ${first.path ?? "<unnamed>"}: ${detail}${total > events.length ? `; ${total - events.length} more not recorded` : ""})`);
    },
    close: () => watchers.forEach((w) => w.close()),
  };
}

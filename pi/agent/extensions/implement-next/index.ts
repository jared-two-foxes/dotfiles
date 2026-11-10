/**
 * /implement-next: run eligible Scaffold issues, one per fresh session, so each
 * task starts with minimal context. Session replacement is only possible from a
 * command handler (not a tool or skill), hence a command.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { invoke, scaffoldFeatures, scaffoldTasks } from "../scaffold/adapter.mjs";
import { describe, implementNext, parseArgs, taskPrompt } from "./loop.mjs";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("implement-next", {
    description: "Implement the next eligible Scaffold issue in a fresh session (--max=N or --all to continue)",
    handler: async (args, ctx) => {
      // After newSession the original ctx is stale; always use the latest one.
      let current: any = ctx;
      try {
        const { featureId: requested, max } = parseArgs(args);
        const cwd = ctx.cwd;
        const featureId = requested ?? await soleFeature(cwd);

        const select = async (operation: "select" | "issue", taskId?: string) => {
          const r = await scaffoldTasks({ operation, feature_id: featureId, ...(taskId ? { task_id: taskId } : {}) }, { directory: cwd });
          if (!r.ok) throw new Error(r.message);
          return r.data;
        };

        const result = await implementNext({
          max,
          selectNext: async () => {
            const data = await select("select");
            if (data.summary.phase !== "implement") {
              throw new Error(`Feature is in the ${data.summary.phase} phase; finish preparation with /skill:init-feature`);
            }
            return data.context
              ? { featureId, taskId: data.context.issue.id, designRef: data.summary.design_ref }
              : null;
          },
          runTask: async (task: any) => {
            const r = await current.newSession({
              parentSession: current.sessionManager?.getSessionFile?.(),
              withSession: async (child: any) => {
                current = child;
                child.ui.notify(`implement-next: ${task.taskId} in a fresh session`, "info");
                await child.sendUserMessage(taskPrompt(task), { expandPromptTemplates: true });
                await child.waitForIdle();
              },
            });
            if (r?.cancelled) throw new Error("New session was cancelled");
          },
          statusOf: async (task: any) => (await select("issue", task.taskId)).context.issue.status,
        });
        current.ui.notify(describe(result), result.stopped === "not-completed" ? "warning" : "info");
      } catch (error) {
        current.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
}

/** `scaffold features` finds .scaffold relative to its working directory, so run it at the Git top level. */
async function repositoryRoot(cwd: string): Promise<string> {
  const git = await invoke("git", ["rev-parse", "--show-toplevel"], { cwd });
  if (git.code !== 0) throw new Error("Current directory must be inside the target Git repository");
  return git.stdout.trim();
}

async function soleFeature(cwd: string): Promise<string> {
  const features = await scaffoldFeatures(await repositoryRoot(cwd));
  const ids = features.map((f: any) => f.id ?? f.feature_id).filter(Boolean);
  if (ids.length !== 1) {
    throw new Error(ids.length ? `Several features are open (${ids.join(", ")}); pass the feature id` : "No open Scaffold feature");
  }
  return ids[0];
}

import { finalizeVerifiedTask } from "../execution-recovery/checkpoint-recovery.mjs";
import { defineTool, toolResult, withFailureReporting } from "../../lib/host/tool.mjs";

/** Host-neutral tools. `Type` is a TypeBox-style schema builder supplied by the host adapter. */
export function createCheckpointTools(Type) {
  return [
    withFailureReporting(defineTool({
      name: "checkpoint_verified_task",
      label: "Checkpoint verified task",
      description:
        "Recover automatic finalization using a successful implementation receipt: record matching Scaffold completion if needed, then create or recover ONE commit of the exact reviewed tree through Conductor. Never reapply operations or rerun review to recover a failed commit. Uses retained feature authority.",
      parameters: Type.Object({
        task: Type.Object({
          featureId: Type.String(),
          taskId: Type.String(),
          designRef: Type.String(),
        }),
        evidenceRef: Type.String(),
        featureBaseRef: Type.String({
          description:
            "Original feature-start SHA, preserved across all task checkpoints",
        }),
        branch: Type.String({
          description: "Explicit authorized feature branch",
        }),
        defaultBranch: Type.String({
          description: "Known actual repository default branch",
        }),
        protectedBranches: Type.Array(Type.String(), {
          description: "All additional known protected branches; [] if none",
        }),
      }),
      async execute(params, host) {
        return toolResult(
          await finalizeVerifiedTask(params, { directory: host.cwd, abort: host.signal }),
        );
      },
    })),
  ];
}

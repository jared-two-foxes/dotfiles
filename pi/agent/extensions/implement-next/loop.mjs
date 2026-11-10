// Pure control flow for /implement-next. No Pi, Git or Scaffold imports: the
// extension injects them so the loop can be tested without a running agent.

const USAGE = "Usage: /implement-next [feature-id] [--max=N | --all]";

/** @returns {{featureId?: string, max: number}} */
export function parseArgs(args) {
  let featureId;
  let max = 1;
  for (const word of String(args ?? "").trim().split(/\s+/).filter(Boolean)) {
    if (word === "--all") max = Infinity;
    else if (/^--max=\d+$/.test(word) && Number(word.slice(6)) >= 1) max = Number(word.slice(6));
    else if (!word.startsWith("-") && featureId === undefined) featureId = word;
    else throw new Error(USAGE);
  }
  return { featureId, max };
}

/** The prompt a fresh session receives. Identity only: design and criteria live in Scaffold. */
export function taskPrompt({ featureId, taskId, designRef }) {
  return [
    "/skill:implement-task",
    "",
    "Implement exactly one Scaffold issue, then stop and report the outcome.",
    `featureId: ${featureId}`,
    `taskId: ${taskId}`,
    `task.designRef: ${designRef}`,
    "",
    "This is a fresh session. Recover the persisted issue design, criteria, baseline",
    "and any prior attempts through scaffold_tasks `issue` and `prepare_issue_handoff`;",
    "do not ask for design or execution approval. Do not select or start another issue.",
  ].join("\n");
}

/**
 * Run eligible issues one per fresh session until `max`, no eligible issue, or an
 * issue that does not end `completed`. Outcomes are read from Scaffold, never from
 * the child session's prose.
 *
 * @param {object} deps
 * @param {() => Promise<null | {featureId: string, taskId: string, designRef: string}>} deps.selectNext
 * @param {(task: object) => Promise<void>} deps.runTask  runs the child session to idle
 * @param {(task: object) => Promise<string>} deps.statusOf  Scaffold status of the task after the run
 * @param {number} deps.max
 */
export async function implementNext({ selectNext, runTask, statusOf, max }) {
  const completed = [];
  while (completed.length < max) {
    const task = await selectNext();
    if (!task) return { stopped: "no-eligible-issue", completed };
    await runTask(task);
    const status = await statusOf(task);
    if (status !== "completed") return { stopped: "not-completed", task, status, completed };
    completed.push(task.taskId);
  }
  return { stopped: "max-reached", completed };
}

export function describe(result) {
  const done = result.completed.length ? `Completed: ${result.completed.join(", ")}. ` : "";
  switch (result.stopped) {
    case "max-reached":
      return done + "Stopped at the requested limit.";
    case "no-eligible-issue":
      return done + "No eligible issue. This is not proof the feature is complete: " +
        "run /skill:feature-delivery to check phase and run validate_feature.";
    default:
      return done + `Issue ${result.task.taskId} ended ${result.status}, not completed. ` +
        "Inspect it with scaffold_tasks `issue` / inspect_issue_attempt in this session " +
        "or resume with /skill:feature-delivery.";
  }
}

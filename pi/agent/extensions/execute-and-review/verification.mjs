// Normalize the caller's verification plan; Conductor owns command execution.
import { fileURLToPath } from "node:url";
const legacyMeaningfulTestScript = fileURLToPath(new URL("../conductor/meaningful-test-condition.mjs", import.meta.url));
export function meaningfulChecks(checks) {
  return checks.map((c) => {
    const runner = c.command[0]
      .split(/[\\/]/)
      .at(-1)
      .replace(/\.exe$/, "");
    const recognized =
      (runner === "cargo" &&
        c.command.includes("test") &&
        !c.command.includes("--no-run")) ||
      ["pytest", "vitest", "jest", "mocha"].includes(runner) ||
      (["python", "python3"].includes(runner) && c.command.includes("pytest"));
    return recognized && !c.successCondition
      ? {
          ...c,
          successCondition: [
            process.execPath,
            fileURLToPath(
              new URL("./meaningful-test-condition.mjs", import.meta.url),
            ),
          ],
        }
      : c;
  });
}
export function meaningfulTestEvaluator(command) {
  return meaningfulChecks([{ command }])[0].successCondition;
}

export function verificationChecks(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("Verification arguments must be an object");
  }

  function command(value, label) {
    if (
      !Array.isArray(value) ||
      value.length < 1 ||
      value.length > 64 ||
      value.some(
        (part) =>
          typeof part !== "string" ||
          !part ||
          part.includes("\0") ||
          part.length > 8192,
      ) ||
      !value[0].trim()
    ) {
      throw new Error(
        label + " must be a nonempty executable-and-arguments array",
      );
    }
    return [...value];
  }

  if (
    !Array.isArray(args.checks) ||
    args.checks.length < 1 ||
    args.checks.length > 64
  ) {
    throw new Error(
      "checks must contain between 1 and 64 named verification commands",
    );
  }

  const names = new Set();

  return args.checks.map((check) => {
    if (
      !check ||
      typeof check !== "object" ||
      Array.isArray(check) ||
      Object.keys(check).some(
        (key) => !["name", "command", "successCondition"].includes(key),
      ) ||
      typeof check.name !== "string" ||
      !check.name.trim() ||
      check.name.length > 256 ||
      check.name.includes("\0") ||
      check.name !== check.name.trim() ||
      names.has(check.name)
    ) {
      throw new Error(
        "Each check reqiures a unique nonblank name and a command (no other fields)",
      );
    }

    names.add(check.name);
    return {
      name: check.name,
      command: command(check.command, "checks." + check.name + ".command"),
      ...(check.successCondition === undefined
        ? {}
        : {
            successCondition: command(
              check.successCondition,
              "checks." + check.name + ".successCondition",
            ),
          }),
    };
  });
}

export function sameVerification(left, right) {
  return (
    JSON.stringify(verificationChecks(left)) ===
    JSON.stringify(verificationChecks(right))
  );
}

// Repair a retained check without silently replacing the verification contract.
// The original design still governs coverage; every command is rerun and Review
// must approve the result. Both preflight and receipt authentication use this rule.
export function correctionVerification(previous, args) {
  const reason = args.verificationRepairReason;
  if (
    reason !== undefined &&
    (typeof reason !== "string" ||
      !reason.trim() ||
      reason.length > 4000 ||
      reason.includes("\0"))
  )
    return false;
  const before = verificationChecks(previous.args);
  const after = verificationChecks(args);
  const evaluatorRepairs = Array.isArray(args.contextUpdates) ? args.contextUpdates.filter(u =>
    u.kind === "repair_check" && u.useMeaningfulTestEvaluator === true) : [];
  if (evaluatorRepairs.length) {
    const oldDesign = previous.args.deliveryContext?.design?.reference;
    const approvedDesign = previous.recovery?.feature?.tasks?.[previous.task?.taskId]?.designs?.at(-1)?.reference;
    return !!args.deliveryContext && previous.kind === "issue-handoff" &&
      previous.result.reason === "ISSUE_RECOVERY_READY" &&
      !!oldDesign && !!approvedDesign && oldDesign !== approvedDesign &&
      args.deliveryContext.design?.reference === approvedDesign &&
      after.length === before.length &&
      before.every((check, i) => {
        const next = after[i];
        if (check.name !== next.name || JSON.stringify(check.command) !== JSON.stringify(next.command)) return false;
        if (JSON.stringify(check.successCondition) === JSON.stringify(next.successCondition)) return true;
        const evaluator = meaningfulTestEvaluator(check.command);
        return !!check.successCondition && !!evaluator &&
          (JSON.stringify(next.successCondition) === JSON.stringify(evaluator) ||
            JSON.stringify(next.successCondition) === JSON.stringify([evaluator[0], legacyMeaningfulTestScript])) &&
          evaluatorRepairs.some(u => u.checkId === check.name && typeof u.reason === "string" && u.reason.trim());
      });
  }
  if (JSON.stringify(before) === JSON.stringify(after)) return true;
  if (args.deliveryContext && Array.isArray(args.contextUpdates)) {
    const repairs = args.contextUpdates.filter(
      (u) => u.kind === "repair_check",
    );
    const additions = args.contextUpdates.filter((u) => u.kind === "add_check");
    if (
      after.length === before.length + additions.length &&
      before.every(
        (c, i) =>
          c.name === after[i].name &&
          JSON.stringify(c.successCondition) ===
            JSON.stringify(after[i].successCondition) &&
          (JSON.stringify(c.command) === JSON.stringify(after[i].command) ||
            repairs.some(
              (u) =>
                u.checkId === c.name &&
                typeof u.reason === "string" &&
                u.reason.trim(),
            )),
      )
    )
      return true;
  }
  if (!reason || !["BLOCKED", "NEEDS_DESIGN"].includes(previous.result.status))
    return false;
  return (
    before.length === after.length &&
    before.every(
      (check, i) =>
        check.name === after[i].name &&
        JSON.stringify(check.successCondition) ===
          JSON.stringify(after[i].successCondition),
    )
  );
}

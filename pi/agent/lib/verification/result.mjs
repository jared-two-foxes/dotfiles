import { obligationsVerified } from "./obligations.mjs";
import { verificationChecks } from "./checks.mjs";
import { authenticNormalized } from "./workflow.mjs";
// Structural success is necessary, never proof that meaningful tests ran. Pi
// must also inspect check output and the independently produced review content.
// With `noDelta` (the task changed nothing relative to its base) open obligations are not required to be
// verified by this task-level review: they stay open on the task, so final feature validation still must
// verify every one of them before anything passes.
export function verifiedResult(result, args, { noDelta = false } = {}) {
  let checks;
  try {
    checks = verificationChecks(args);
  } catch {
    return false;
  }
  const c = result?.conductor;
  return (
    result?.status === "PASSED" &&
    c?.schema === "pi.conductor-result/v1" &&
    authenticNormalized(c) &&
    c.status === "PASSED" &&
    c.phase === "review" &&
    !c.error &&
    c.execution?.success === true &&
    Array.isArray(c.checks) &&
    c.checks.length === checks.length &&
    checks.every(
      (check, index) =>
        c.checks[index]?.name === check.name &&
        c.checks[index].status === "PASSED" &&
        (check.successCondition || c.checks[index].exit_code === 0),
    ) &&
    c.review?.status === "APPROVED" &&
    (noDelta || obligationsVerified(args ?? {}, c.review))
  );
}

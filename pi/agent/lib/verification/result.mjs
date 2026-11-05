import { obligationsVerified } from "./obligations.mjs";
import { verificationChecks } from "./checks.mjs";
import { authenticNormalized } from "./workflow.mjs";
// Structural success is necessary, never proof that meaningful tests ran. Pi
// must also inspect check output and the independently produced review content.
export function verifiedResult(result, args) {
  let checks;
  try {
    checks = verificationChecks(args);
  } catch {
    return false;
  }
  const c = result?.conductor;
  return (
    result?.status === "PASSED" &&
    (c?.schema === "conductor.result/v1" ||
      (c?.schema === "pi.conductor-result/v1" && authenticNormalized(c))) &&
    c.status === "PASSED" &&
    c.phase === "review" &&
    !c.error &&
    c.execution?.success === true &&
    Array.isArray(c.checks) &&
    c.checks.length === checks.length &&
    checks.every(
      (check, index) =>
        c.checks[index]?.name === check.name &&
        (c.schema === "conductor.result/v1"
          ? c.checks[index].exit_code === 0
          : c.checks[index].status === "PASSED" &&
            (check.successCondition || c.checks[index].exit_code === 0)),
    ) &&
    c.review?.status === "APPROVED" &&
    obligationsVerified(args ?? {}, c.review)
  );
}

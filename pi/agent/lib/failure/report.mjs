// One failure shape for every Pi tool, and a best-effort record of it in the feature's ledger.
//
// Tools return their own result shapes ({ ok:false, reason, message }, { status:'BLOCKED', stage, reason }, a
// Scaffold COMMAND_FAILED envelope, or throw). `failureEnvelope` reads any of them and says, in one place,
// what failed (`code`, `message`, `cause`), who has to act (`owner`) and what to do next (`next`).
import { git } from "../git/tree.mjs";
import { scaffoldCall } from "../scaffold/client.mjs";
import { FAILURE_CODES, NEEDS_DESIGN_GUIDANCE, describeCode } from "./codes.mjs";
import { readEvidence } from "../evidence/store.mjs";
import { readIssueHandoff } from "../verification/issue-handoff.mjs";

const REFERENCE = /^sha256:[a-f0-9]{64}$/;
const CODE = /^[A-Z][A-Z0-9_]{2,63}$/;
const clip = (value, limit) => (typeof value === "string" && value.trim() ? value.trim().slice(0, limit) : undefined);

/** True when a tool result is a failure: it blocked, or it says ok:false. NEEDS_DESIGN is a normal retry loop. */
export function isFailure(result) {
  if (!result || typeof result !== "object" || result.ok === true) return false; // ok:true is a success, whatever status it reports
  if (result.ok === false) return true;
  return result.status === "BLOCKED" && !describeCode(result.reason).info;
}

const firstText = (...values) => values.map((v) => clip(v, 2000)).find(Boolean);

/** The code a result carries, however it carries it, and the review or failure details behind it. */
function diagnose(result) {
  const conductor = result.conductor ?? result.actualResult?.conductor;
  const review = conductor?.review;
  const failure = conductor?.failure;
  if (CODE.test(result.reason ?? "")) return { code: result.reason, conductor };
  if (CODE.test(failure?.code ?? "")) return { code: failure.code, category: failure.category, conductor };
  // The review engine can stop without a top-level reason: its own reason is the diagnosis.
  if (review && !["APPROVED", "CHANGES_REQUESTED"].includes(review.status) && FAILURE_CODES[review.reason])
    return { code: review.reason, conductor };
  return { code: "UNSPECIFIED_FAILURE", conductor };
}

const byCategory = { review_engine: "user", evidence_integrity: "bug", invocation: "agent" };

/** The failure a tool result describes, or null when it is not a failure (or is a deliberate parked state). */
export function failureEnvelope(tool, result, { cause } = {}) {
  const needsDesign = result?.status === "NEEDS_DESIGN" && result.ok !== true;
  if (!isFailure(result) && !needsDesign) return null;
  const scaffold = result.scaffold_error?.error;
  const { code: found, category, conductor } = diagnose(result);
  const code = needsDesign ? "NEEDS_DESIGN" : found;
  const known = needsDesign
    ? NEEDS_DESIGN_GUIDANCE[tool] ?? NEEDS_DESIGN_GUIDANCE.default
    : FAILURE_CODES[code] ?? { ...describeCode("UNSPECIFIED_FAILURE"), owner: byCategory[category] ?? describeCode("UNSPECIFIED_FAILURE").owner };
  const evidence = [result.evidence?.reference, result.evidenceRef, result.diagnosticEvidenceRef].find((r) => REFERENCE.test(r ?? ""));
  const next = [...known.next];
  if (typeof result.recovery === "string" && !next.includes(result.recovery)) next.push(result.recovery);
  const review = conductor?.review;
  const failedCheck = conductor?.checks?.find((c) => c?.status !== undefined ? c.status !== "PASSED" : c?.exit_code !== 0);
  const message = firstText(
    scaffold,
    result.message,
    review && !["APPROVED", "CHANGES_REQUESTED"].includes(review.status) ? "Independent review stopped: " + review.reason : undefined,
    conductor?.failure ? "Verification failed (" + conductor.failure.category + "): " + conductor.failure.code : undefined,
    conductor?.error,
    conductor?.execution?.error,
    failedCheck ? "Check " + failedCheck.name + " exited " + failedCheck.exit_code : undefined,
    result.reason,
  ) ?? code;
  const detail = firstText(
    cause,
    scaffold ? result.stderr : undefined,
    conductor?.error,
    conductor?.failed_command?.stderr,
    failedCheck?.stderr,
    review?.reason,
  );
  return {
    code,
    tool,
    owner: known.owner,
    message,
    ...(clip(result.stage, 64) ? { stage: clip(result.stage, 64) } : {}),
    ...(detail && detail !== message ? { cause: clip(detail, 4000) } : {}),
    ...(evidence ? { evidence } : {}),
    ...(next.length ? { next: next.slice(0, 5).map((step) => step.slice(0, 300)) } : {}),
  };
}

/** The envelope for an exception a tool did not handle: a bug in the pipeline, with where it happened. */
export function exceptionEnvelope(tool, error) {
  const known = describeCode("INTERNAL_ERROR");
  const where = String(error?.stack ?? "").split("\n").slice(0, 6).join("\n");
  return {
    code: "INTERNAL_ERROR",
    tool,
    owner: known.owner,
    message: clip(error?.message ?? String(error), 2000) ?? "Unexpected error",
    cause: clip(where, 4000),
    next: known.next,
  };
}

const featureOf = (params) => params?.task?.featureId ?? params?.featureId ?? params?.feature_id;
const taskOf = (params) => params?.task?.taskId ?? params?.taskId ?? params?.task_id;

/**
 * The feature and task a failure belongs to. A reference-only continuation (previousAttempt or issueHandoffRef)
 * names no task in its arguments, so the binding comes from the result, then from the retained receipt or handoff.
 */
async function resolveTarget(repository, params, result) {
  if (featureOf(params)) return { featureId: featureOf(params), taskId: taskOf(params) };
  const bound = result?.evidence?.task;
  if (bound?.featureId) return { featureId: bound.featureId, taskId: bound.taskId };
  if (typeof params?.previousAttempt === "string")
    try {
      const { task } = await readEvidence(repository, params.previousAttempt);
      if (task?.featureId) return { featureId: task.featureId, taskId: task.taskId };
    } catch {}
  if (typeof params?.issueHandoffRef === "string")
    try {
      const { record } = await readIssueHandoff({ reference: params.issueHandoffRef }, { directory: repository });
      if (record?.binding?.featureId) return { featureId: record.binding.featureId, taskId: record.binding.taskId };
    } catch {}
  return {};
}

/**
 * Append the failure to the feature's ledger. Best effort: it never throws and never replaces the failure it
 * describes. Returns true when it was recorded.
 */
export async function recordFailure(directory, params, envelope, options = {}, result) {
  if (!directory || !envelope) return false;
  try {
    const repository = git(directory, ["rev-parse", "--show-toplevel"]);
    const target = await resolveTarget(repository, params, result);
    const featureId = target.featureId;
    if (!featureId) return false;
    let payload = envelope, taskId = target.taskId;
    for (let tries = 0; ; tries++) {
      try {
        await scaffoldCall(repository,
          { operation: "failure-record", feature_id: featureId, ...(taskId ? { task_id: taskId } : {}), payload },
          options.scaffoldOptions);
        break;
      } catch (error) {
        // A failure must not be lost to an unrelated detail: drop an unknown task or an unstored reference.
        const detail = error.detail ?? "";
        if (tries >= 2) throw error;
        if (taskId && /Unknown issue/.test(detail)) taskId = undefined;
        else if (payload.evidence && /artifact|reference/i.test(detail)) {
          const { evidence: _unstored, ...rest } = payload;
          payload = rest;
        }
        else throw error;
      }
    }
    return true;
  } catch {
    return false;
  }
}


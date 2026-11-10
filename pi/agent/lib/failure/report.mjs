// One failure shape for every Pi tool, and a best-effort record of it in the feature's ledger.
//
// Tools return their own result shapes ({ ok:false, reason, message }, { status:'BLOCKED', stage, reason }, a
// Scaffold COMMAND_FAILED envelope, or throw). `failureEnvelope` reads any of them and says, in one place,
// what failed (`code`, `message`, `cause`), who has to act (`owner`) and what to do next (`next`).
import { git } from "../git/tree.mjs";
import { scaffoldCall } from "../scaffold/client.mjs";
import { describeCode } from "./codes.mjs";

const REFERENCE = /^sha256:[a-f0-9]{64}$/;
const CODE = /^[A-Z][A-Z0-9_]{2,63}$/;
const clip = (value, limit) => (typeof value === "string" && value.trim() ? value.trim().slice(0, limit) : undefined);

/** True when a tool result is a failure: it blocked, or it says ok:false. NEEDS_DESIGN is a normal retry loop. */
export function isFailure(result) {
  if (!result || typeof result !== "object") return false;
  if (result.ok === false) return true;
  return result.status === "BLOCKED" && !describeCode(result.reason).info;
}

/** The failure a tool result describes, or null when it is not a failure (or is a deliberate parked state). */
export function failureEnvelope(tool, result, { cause } = {}) {
  const needsDesign = result?.status === "NEEDS_DESIGN";
  if (!isFailure(result) && !needsDesign) return null;
  const scaffold = result.scaffold_error?.error;
  const code = CODE.test(result.reason ?? "") ? result.reason : needsDesign ? "NEEDS_DESIGN" : "UNSPECIFIED_FAILURE";
  const known = needsDesign ? { owner: "agent", next: ["Fix what the failed check or review findings describe, then continue with previousAttempt; consumed attempts are never reset."] } : describeCode(code);
  const evidence = [result.evidence?.reference, result.evidenceRef, result.diagnosticEvidenceRef].find((r) => REFERENCE.test(r ?? ""));
  const next = [...known.next];
  if (typeof result.recovery === "string" && !next.includes(result.recovery)) next.push(result.recovery);
  const envelope = {
    code,
    tool,
    owner: known.owner,
    message: clip(scaffold ?? result.message ?? result.conductor?.error ?? result.reason, 2000) ?? code,
    ...(clip(result.stage, 64) ? { stage: clip(result.stage, 64) } : {}),
    ...(clip(cause ?? (scaffold ? result.stderr : undefined) ?? result.conductor?.error, 4000) ? { cause: clip(cause ?? (scaffold ? result.stderr : undefined) ?? result.conductor?.error, 4000) } : {}),
    ...(evidence ? { evidence } : {}),
    ...(next.length ? { next: next.slice(0, 5).map((step) => step.slice(0, 300)) } : {}),
  };
  return envelope;
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
 * Append the failure to the feature's ledger. Best effort: it never throws and never replaces the failure it
 * describes. Returns true when it was recorded.
 */
export async function recordFailure(directory, params, envelope, options = {}) {
  const featureId = featureOf(params);
  if (!directory || !featureId || !envelope) return false;
  try {
    const repository = git(directory, ["rev-parse", "--show-toplevel"]);
    let payload = envelope, taskId = taskOf(params);
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


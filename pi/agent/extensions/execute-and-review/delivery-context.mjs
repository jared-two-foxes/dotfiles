import { isDeepStrictEqual as equal } from "node:util";
import { issueFeature, scaffoldTasks } from "../scaffold/adapter.mjs";
import { readEvidence } from "../../lib/evidence/store.mjs";
import { taskReceipts, recoverAttempt } from "../../lib/evidence/attempts.mjs";
import { authenticateAttemptChain } from "../../lib/verification/attempt-chain.mjs";
import { verificationChecks, correctionVerification } from "../../lib/verification/checks.mjs";
import { issueRequirements } from "../../lib/scaffold/contracts.mjs";
import { authenticateAmendment } from "../../lib/authorization/amendment.mjs";
import {
  assertDeliveryJournal,
  anchorDeliveryJournal,
  deliveryContractItems,
  updateContext,
  renderContext,
  validContextContinuation,
} from "../../lib/delivery-state/delivery-context.mjs";
import { findingObligations } from "../../lib/verification/obligations.mjs";

const requireValue = (ok, message) => { if (!ok) throw new Error(message); };
const text = (v) => typeof v === "string" && v.trim() && !v.includes("\0");

export async function deliveryEvent(repository, task, journal, event, options = {}) {
  assertDeliveryJournal(repository, task, journal, options.featureInstanceId);
  const r = await scaffoldTasks(
    {
      operation: "delivery-record",
      feature_id: task.featureId,
      task_id: task.taskId,
      payload: { expected_revision: journal?.revision ?? 0, event },
    },
    { directory: repository },
    options.scaffoldOptions,
  );
  requireValue(r.ok, "DELIVERY_STATE: " + r.message + " " + (r.stderr ?? ""));
  return anchorDeliveryJournal(repository, task, journal,
    r.data.feature.tasks[task.taskId].delivery, options.featureInstanceId);
}

export async function prepareDelivery(repository, feature, issue, args, options = {}) {
  requireValue(
    issue.delivery_policy === "versioned-context/v1",
    "UNSUPPORTED_DELIVERY_FORMAT: current versioned delivery policy is required",
  );
  const records = args.previousAttempt
    ? (await authenticateAttemptChain(repository, args.previousAttempt, args.task)).records
    : [];
  const instanceId = feature.workflow?.instance_id;
  const scopedOptions = { ...options, featureInstanceId: instanceId };
  let journal = issue.delivery;
  assertDeliveryJournal(repository, args.task, journal, instanceId);
  if (journal?.inflight) {
    // Recover a terminal response lost before the Scaffold finish transaction.
    let terminal = (await taskReceipts(repository, args.task, options))
      .filter(({ record }) => record.startedReference === journal.inflight && equal(record.task, args.task))
      .map(({ reference }) => reference);
    if (!terminal.length && args.previousAttempt)
      // The terminal receipt may have been stored but not yet recorded as an attempt: record it now.
      try {
        const found = await recoverAttempt(repository, args.previousAttempt, args.task, options);
        if (found.record.startedReference === journal.inflight) terminal = [found.reference];
      } catch {} // Not recoverable from this reference: fall through to the explicit recovery error.
    requireValue(
      terminal.length === 1 && terminal[0] === args.previousAttempt,
      "INVOCATION_RECOVERY_REQUIRED: retained intent may still be active; inspect terminal stages, never replay",
    );
    journal = await deliveryEvent(repository, args.task, journal,
      { kind: "finished", started: journal.inflight, reference: terminal[0] }, scopedOptions);
  }
  if (journal) {
    if (journal.head !== (args.previousAttempt ?? null)) {
      const error = new Error(
        "EVIDENCE_RECOVERY_REQUIRED: use the anchored latest receipt; preserve the current source/index",
      );
      if (args.previousAttempt) {
        error.code = "CONTINUATION_RECEIPT_STALE";
        error.consumedAttempts = journal.sequence;
      }
      throw error;
    }
    if (journal.head)
      try {
        await readEvidence(repository, journal.head);
      } catch (error) {
        throw new Error(
          "EVIDENCE_RECOVERY_REQUIRED: anchored receipt is missing/corrupt: " + error.message,
        );
      }
  }
  const previous = records.at(-1);
  if (previous && previous.kind !== "issue-zero-handoff") {
    requireValue(previous.args.deliveryContext?.schema === "pi.delivery-context/v1",
      "UNSUPPORTED_DELIVERY_FORMAT: retained attempt requires versioned context");
    requireValue(journal, "EVIDENCE_RECOVERY_REQUIRED: delivery journal is missing");
  }
  let context = journal?.context ?? {
    schema: "pi.delivery-context/v1",
    original: issueRequirements(issue, args.requirements ?? "") +
      "\nFeature contract: " + JSON.stringify({
        objective: feature.objective,
        criteria: feature.acceptance_criteria,
        constraints: feature.constraints,
      }),
    design: structuredClone(issue.designs.at(-1)),
    obligations: [],
    updates: [],
    contractItems: deliveryContractItems(feature, issue, args.task),
  };
  context = structuredClone(context);
  requireValue(context.schema === "pi.delivery-context/v1" && Array.isArray(context.contractItems),
    "UNSUPPORTED_DELIVERY_FORMAT: current context and contract items required");
  for (const a of context.amendments ?? [])
    requireValue(
      equal(await authenticateAmendment(repository, a.reference, args.task), a),
      "Changed amendment authority",
    );
  if (!equal(context.design, issue.designs.at(-1))) {
    context.updates.push({
      kind: "revise_design",
      text: JSON.stringify(issue.designs.at(-1)),
      reason: "Persisted approved issue design transition; previous design remains in history",
    });
    context.design = structuredClone(issue.designs.at(-1));
  }
  for (const o of findingObligations(records)) {
    const existing = context.obligations.find((v) => v.id === o.id);
    if (existing) existing.status = o.status;
    else context.obligations.push(o);
  }
  for (const r of records)
    for (const a of r.result.conductor?.review?.obligation_assessments ?? []) {
      const o = context.obligations.find((o) => o.id === a.obligation_id);
      if (o && a.disposition === "verified" && text(a.evidence) &&
          r.result.conductor.review.reason === "REVIEW_COMPLETED")
        o.status = "independently_verified";
    }
  if (!journal)
    journal = await deliveryEvent(repository, args.task, null, {
      kind: "initialized",
      context,
      head: args.previousAttempt ?? null,
      sequence: previous?.attempt ?? 0,
    }, scopedOptions);
  const updates = args.contextUpdates ?? [];
  requireValue(previous?.kind === "issue-handoff" ||
    !updates.some(u => u.kind === "repair_check" && u.useMeaningfulTestEvaluator === true),
    "Evaluator repair requires an authenticated issue handoff after approved redesign");
  const approved = new Map();
  for (const u of updates)
    if (u.kind === "apply_amendment")
      approved.set(u.reference, await authenticateAmendment(repository, u.reference, args.task));
  const revised = updateContext(
    context, updates,
    args.callerPlan ? verificationChecks(args) : (context.verification ?? verificationChecks(args)),
    !previous, approved,
  );
  const effectiveUpdates = revised.context.updates.slice(
    previous?.args.deliveryContext?.updates.length ?? 0,
  );
  const planned = {
    ...args,
    contextUpdates: effectiveUpdates,
    checks: revised.checks,
    requirements: renderContext(revised.context),
    deliveryContext: revised.context,
  };
  requireValue(!previous || previous.kind === "issue-zero-handoff" || correctionVerification(previous, planned),
    "Verification plan mismatch; use structured repair_check updates without weakening coverage. Evaluator repair requires an authenticated redesign handoff and the same test command and check order");
  requireValue(!previous || previous.kind === "issue-zero-handoff" || validContextContinuation(previous, planned),
    "Original review context or inherited obligations changed; restore authoritative records before execution");
  if (!equal(journal.context, revised.context))
    journal = await deliveryEvent(repository, args.task, journal,
      { kind: "context", updates, context: revised.context }, scopedOptions);
  return { journal, records, args: planned, instanceId };
}

export async function anchorHandoff(repository, task, reference, previous, options = {}) {
  const f = await issueFeature(repository, task, options),
    journal = f?.tasks[task.taskId]?.delivery;
  if (!journal || journal.head === reference) return;
  await deliveryEvent(repository, task, journal,
    { kind: "handoff", reference, previous: previous ?? null },
    { ...options, featureInstanceId: f.workflow?.instance_id });
}

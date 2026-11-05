import { isDeepStrictEqual as equal } from "node:util";
import { issueFeature, scaffoldTasks } from "../scaffold/adapter.mjs";
import { readEvidence, taskEvidenceReferences } from "../../lib/evidence/store.mjs";
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
  assertDeliveryJournal(repository, task, journal);
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
  return anchorDeliveryJournal(repository, task, journal, r.data.feature.tasks[task.taskId].delivery);
}

export async function prepareDelivery(repository, feature, issue, args, options = {}) {
  requireValue(
    issue.delivery || args.previousAttempt || issue.delivery_policy === "versioned-context/v1",
    "EVIDENCE_RECOVERY_REQUIRED: legacy issue has execution history but no latest receipt. Recover original evidence; never assume zero consumed invocations",
  );
  const records = args.previousAttempt
    ? (await authenticateAttemptChain(repository, args.previousAttempt, args.task)).records
    : [];
  let journal = issue.delivery;
  assertDeliveryJournal(repository, args.task, journal);
  if (journal?.inflight) {
    // Recover a terminal response lost before the Scaffold finish transaction.
    const terminal = [];
    for (const reference of await taskEvidenceReferences(repository)) {
      const r = await readEvidence(repository, reference);
      if (r.startedReference === journal.inflight && equal(r.task, args.task))
        terminal.push(reference);
    }
    requireValue(
      terminal.length === 1 && terminal[0] === args.previousAttempt,
      "INVOCATION_RECOVERY_REQUIRED: retained intent may still be active; inspect terminal stages, never replay",
    );
    journal = await deliveryEvent(repository, args.task, journal,
      { kind: "finished", started: journal.inflight, reference: terminal[0] }, options);
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
  let context = journal?.context ?? previous?.args.deliveryContext ?? {
    schema: "pi.delivery-context/v1",
    original: issueRequirements(issue, previous?.args.requirements ?? args.requirements ?? "") +
      "\nFeature contract: " + JSON.stringify({
        objective: feature.objective,
        criteria: feature.acceptance_criteria,
        constraints: feature.constraints,
      }),
    design: structuredClone(issue.designs.at(-1)),
    obligations: [],
    updates: [],
  };
  context = structuredClone(context);
  context.contractItems ??= deliveryContractItems(feature, issue, args.task);
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
    }, options);
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
    ...(updates.some((u) => u.kind === "repair_check") ? {
      verificationRepairReason: updates.filter((u) => u.kind === "repair_check").map((u) => u.reason).join("\n"),
    } : {}),
  };
  requireValue(!previous || previous.kind === "issue-zero-handoff" || correctionVerification(previous, planned),
    "Verification plan mismatch; use a structured repair or verificationRepairReason without weakening coverage. Evaluator repair requires an authenticated redesign handoff and the same test command and check order");
  requireValue(!previous || previous.kind === "issue-zero-handoff" || validContextContinuation(previous, planned),
    "Original review context or inherited obligations changed; restore authoritative records before execution");
  if (!equal(journal.context, revised.context))
    journal = await deliveryEvent(repository, args.task, journal,
      { kind: "context", updates, context: revised.context }, options);
  return { journal, records, args: planned };
}

export async function anchorHandoff(repository, task, reference, previous, options = {}) {
  const f = await issueFeature(repository, task, options),
    journal = f?.tasks[task.taskId]?.delivery;
  if (!journal || journal.head === reference) return;
  await deliveryEvent(repository, task, journal,
    { kind: "handoff", reference, previous: previous ?? null }, options);
}

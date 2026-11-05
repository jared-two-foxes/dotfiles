// Versioned additive review context. Scaffold owns storage; receipts own execution proof.
import { isDeepStrictEqual as equal } from "node:util";
import { createHash } from "node:crypto";
import {
  verificationChecks,
  meaningfulChecks,
  meaningfulTestEvaluator,
} from "./verification.mjs";
import { git } from "./git-tree.mjs";
const canonical = (v) =>
  Array.isArray(v)
    ? v.map(canonical)
    : v && typeof v === "object"
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, canonical(v[k])]),
        )
      : v;
const hash = (v) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(v)))
    .digest("hex");
const requireValue = (ok, message) => {
  if (!ok) throw new Error(message);
};
const text = (v) => typeof v === "string" && v.trim() && !v.includes("\0");
const anchorName = (task) => "refs/pi-delivery-journals/" + hash(task);
const anchorBody = (j) => ({
  revision: j.revision,
  head: j.head,
  inflight: j.inflight,
  sequence: j.sequence,
  contextDigest: hash(j.context),
  contractDigest: hash(j.contract),
});
function deliveryAnchor(repository, task) {
  try {
    return {
      sha: git(repository, ["rev-parse", anchorName(task)]),
      body: JSON.parse(git(repository, ["show", anchorName(task)])),
    };
  } catch {
    return null;
  }
}

export function assertDeliveryJournal(repository, task, journal) {
  const prior = deliveryAnchor(repository, task);
  requireValue(
    journal ? prior && equal(prior.body, anchorBody(journal)) : !prior,
    "EVIDENCE_RECOVERY_REQUIRED: delivery journal and Git audit anchor disagree; restore retained history",
  );
  return prior;
}

export function anchorDeliveryJournal(repository, task, journal, next) {
  const prior = assertDeliveryJournal(repository, task, journal);
  const blob = git(repository, ["hash-object", "-w", "--stdin"], {
    input: JSON.stringify(anchorBody(next)),
  });
  git(repository, [
    "update-ref",
    anchorName(task),
    blob,
    prior?.sha ?? "0".repeat(40),
  ]);
  return next;
}

export function deliveryContractItems(feature, issue, task) {
  return [
    ["feature_objective", feature.objective],
    ...feature.acceptance_criteria.map((v, i) => ["feature_criterion_" + i, v]),
    ...(feature.constraints ?? []).map((v, i) => ["feature_constraint_" + i, v]),
    ...issue.acceptance_criteria.map((v, i) => ["issue_criterion_" + task.taskId + "_" + i, v]),
    ...(issue.constraints ?? []).map((v, i) => ["issue_constraint_" + task.taskId + "_" + i, v]),
  ].map(([kind, value]) => ({ id: kind + "-" + hash(value).slice(0, 16), text: value }));
}

export function findingObligations(records) {
  const found = new Map();
  for (const r of records) {
    const review = r.result.conductor?.review;
    for (const [i, f] of (review?.findings ?? []).entries()) {
      if (!f.blocking) continue;
      // Occurrences never disappear through fuzzy deduplication or line movement.
      const id = "finding-" + hash([review.review_id, i, f]).slice(0, 24);
      found.set(id, {
        id,
        text: f.message,
        path: f.path,
        source: review.review_id,
        status: "open",
      });
    }
    for (const [i, c] of (r.result.conductor?.checks ?? []).entries()) {
      if (c.status === "PASSED") continue;
      const id = "check-" + hash([r.task, r.attempt, i, c.name]).slice(0, 24);
      found.set(id, {
        id,
        text:
          "Resolve failed check " +
          c.name +
          (r.result.conductor?.runner?.receipts?.[i + 1]?.sourceBefore
            ? " (retained attempt " + r.attempt + ")"
            : ": " + String(c.stderr ?? c.problem ?? c.stdout ?? "").slice(0, 2000)),
        source: "attempt:" + r.attempt + ":check:" + c.name,
        status: "open",
      });
    }
    if (review?.reason === "REVIEW_COMPLETED")
      for (const a of review.obligation_assessments ?? []) {
        if (
          a.disposition === "verified" &&
          found.has(a.obligation_id) &&
          text(a.evidence)
        )
          found.get(a.obligation_id).status = "independently_verified";
      }
  }
  return [...found.values()];
}

export function updateContext(
  current,
  updates,
  checks,
  normalize = true,
  approved = new Map(),
) {
  requireValue(
    Array.isArray(updates) && updates.length <= 64,
    "contextUpdates must be a bounded array",
  );
  const context = structuredClone(current),
    plan = structuredClone(normalize ? meaningfulChecks(checks) : checks);
  for (const raw of updates) {
    requireValue(
      raw && typeof raw === "object" && !Array.isArray(raw) && text(raw.reason),
      "Context update requires reason",
    );
    const allowed = {
      add_obligation: ["kind", "id", "text", "reason", "findingId"],
      annotate: ["kind", "text", "reason"],
      correct_assumption: ["kind", "text", "reason"],
      revise_design: ["kind", "text", "reason"],
      propose_addressed: ["kind", "findingId", "reason"],
      repair_check: ["kind", "checkId", "command", "useMeaningfulTestEvaluator", "reason"],
      add_check: ["kind", "check", "reason"],
      diagnose: ["kind", "text", "reason", "signature"],
      apply_amendment: ["kind", "reference", "reason"],
    }[raw.kind];
    requireValue(
      allowed && Object.keys(raw).every((k) => allowed.includes(k)),
      "Removing/weakening obligations or material scope changes require an approved design transition",
    );
    if (
      [
        "add_obligation",
        "annotate",
        "correct_assumption",
        "revise_design",
        "diagnose",
      ].includes(raw.kind)
    )
      requireValue(text(raw.text), "Context update requires text");
    if (raw.kind === "add_obligation") {
      const id = raw.id ?? "obligation-" + hash(raw).slice(0, 24);
      requireValue(
        text(id) && !context.obligations.some((o) => o.id === id),
        "Duplicate obligation identity",
      );
      context.obligations.push({
        id,
        text: raw.text,
        status: "open",
        source: raw.findingId ?? "discovery",
      });
    }
    if (raw.kind === "propose_addressed")
      requireValue(
        context.obligations.some((o) => o.id === raw.findingId),
        "Unknown finding; agent claims cannot verify it",
      );
    if (raw.kind === "apply_amendment") {
      requireValue(
        approved.has(raw.reference),
        "Explicit authenticated user approval required for a material amendment",
      );
      context.amendments ??= [];
      requireValue(
        !context.amendments.some((a) => a.reference === raw.reference),
        "Amendment already applied",
      );
      const amendment = approved.get(raw.reference);
      context.amendments.push(amendment);
      context.obligations.push({
        id: "amendment-" + hash(raw.reference).slice(0, 24),
        text: amendment.replacement,
        source: raw.reference,
        status: "open",
      });
    }
    if (raw.kind === "repair_check") {
      const c = plan.find((c) => c.name === raw.checkId);
      requireValue(c, "Unknown check identity");
      if (raw.useMeaningfulTestEvaluator === true) {
        requireValue(raw.command === undefined && c.successCondition,
          "Evaluator repair requires a retained evaluator and preserves the exact test command");
        const evaluator = meaningfulTestEvaluator(c.command);
        requireValue(evaluator, "Evaluator repair requires a recognized test runner");
        c.successCondition = evaluator;
      } else {
        requireValue(raw.useMeaningfulTestEvaluator === undefined, "Invalid evaluator repair flag");
        c.command = raw.command;
      }
    }
    if (raw.kind === "add_check") {
      requireValue(
        raw.check && !plan.some((c) => c.name === raw.check.name),
        "New check must have a new identity",
      );
      plan.push(...meaningfulChecks([raw.check]));
    }
    context.updates.push(structuredClone(raw));
  }
  verificationChecks({ checks: plan });
  context.verification = structuredClone(plan);
  return { context, checks: plan };
}

export function renderContext(c) {
  return (
    c.original +
    "\n\nApproved issue design " +
    c.design.reference +
    "\n" +
    c.design.summary +
    "\nVerification: " +
    c.design.verification +
    "\nApproval record: " +
    c.design.approval +
    "\n\nVersioned issue context (original obligations above remain mandatory):\n" +
    JSON.stringify({
      design: c.design,
      verification: c.verification,
      contractItems: c.contractItems,
      approvedAmendments: c.amendments,
      updates: c.updates,
      obligations: c.obligations,
    }) +
    "\nOriginal text remains retained. Apply only the concrete deltas authorized in approvedAmendments; independently verify replacement behavior and all remaining obligations." +
    "\nIndependent Review must explicitly assess each open obligation using obligation_assessments " +
    "[{obligation_id, disposition: verified|unresolved|not_applicable, evidence}]. " +
    "Agent claims are not verification. Explain coverage equivalence of command repairs; reject zero-test selection."
  );
}

export function validContextContinuation(previous, args) {
  if (!args.deliveryContext)
    return previous.args.requirements === args.requirements;
  const old = previous.args.deliveryContext;
  const next = args.deliveryContext;
  if (args.requirements !== renderContext(next)) return false;
  if (!old) return next.original.includes(previous.args.requirements);
  return (
    old.original === next.original &&
    equal(old.updates, next.updates.slice(0, old.updates.length)) &&
    equal(
      old.amendments ?? [],
      (next.amendments ?? []).slice(0, old.amendments?.length ?? 0),
    ) &&
    old.obligations.every((o) =>
      next.obligations.some(
        (n) => n.id === o.id && n.text === o.text && n.source === o.source,
      ),
    )
  );
}

export function obligationsVerified(args, review) {
  return (args.deliveryContext?.obligations ?? [])
    .filter((o) => o.status !== "independently_verified")
    .every(
      (o) =>
        (args.deliveryContext?.amendments ?? []).some((a) =>
          a.ids.includes(o.id),
        ) ||
        review?.obligation_assessments?.some(
          (a) =>
            a.obligation_id === o.id &&
            a.disposition === "verified" &&
            text(a.evidence),
        ),
    );
}

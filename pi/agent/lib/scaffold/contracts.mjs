// Shared Scaffold request and response contracts. No process or filesystem access.
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
export const OPERATIONS = [
  "init",
  "add",
  "list",
  "start",
  "complete",
  "block",
  "fail",
  "retry",
  "decompose",
  "design-record",
  "design-finish",
  "design-reopen",
  "checkpoint-record",
  "issue-resume",
  "summary",
  "issue",
  "select",
  "design-select",
  "delivery-record",
  "direction-approve",
  "attempt-record",
  "history-foreign",
  "history-rewrite",
  "failure-record",
  "artifact-put",
  "artifact-get",
];
const taskActions = new Set([
  "attempt-record",
  "delivery-record",
  "issue",
  "start",
  "complete",
  "block",
  "fail",
  "retry",
  "decompose",
  "design-record",
  "checkpoint-record",
  "issue-resume",
]);
const inputActions = new Set([
  "failure-record",
  "direction-approve",
  "attempt-record",
  "history-foreign",
  "history-rewrite",
  "artifact-put",
  "artifact-get",
  "delivery-record",
  "init",
  "add",
  "complete",
  "decompose",
  "design-record",
  "design-reopen",
  "checkpoint-record",
  "issue-resume",
]);
const reasonActions = new Set(["block", "fail", "retry"]);
// Ledger references name a blob stored in the feature's ledger: sha256:<64 hex>.
export const isReference = (x) => typeof x === "string" && /^sha256:[a-f0-9]{64}$/.test(x);
const isCommit = (x) => typeof x === "string" && /^[a-f0-9]{40}$/.test(x);
const statuses = new Set([
  "pending",
  "in_progress",
  "completed",
  "blocked",
  "failed",
  "decomposed",
]);
const object = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const text = (x) => typeof x === "string" && !!x.trim() && !x.includes("\0");
const strings = (x) => Array.isArray(x) && x.every(text);
function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}
function fields(value, allowed) {
  requireValue(
    object(value) && Object.keys(value).every((k) => allowed.includes(k)),
    "Unexpected or invalid fields",
  );
}
export function designReference(context) {
  return "sha256:" + createHash("sha256").update(context, "utf8").digest("hex");
}
function validateDesign(feature) {
  requireValue(
    text(feature.context) &&
      feature.design_ref === designReference(feature.context),
    "Approved design digest mismatch; recover original design before continuing",
  );
}
function definition(value, feature = false) {
  fields(value, [
    "id",
    "title",
    "objective",
    "acceptance_criteria",
    "context",
    "constraints",
    ...(feature
      ? ["design_ref", "baseline", "branch"]
      : ["dependencies", "origin"]),
  ]);
  requireValue(
    ["id", "title", "objective", ...(feature ? ["design_ref"] : [])].every(
      (k) => text(value[k]),
    ),
    "Definition requires nonempty id, title, objective and (for features) design_ref",
  );
  requireValue(
    strings(value.acceptance_criteria) && value.acceptance_criteria.length > 0,
    "acceptance_criteria must be a nonempty string array",
  );
  requireValue(
    value.context === undefined || typeof value.context === "string",
    "context must be a string",
  );
  requireValue(
    value.constraints === undefined || strings(value.constraints),
    "constraints must be a string array",
  );
  if (feature)
    requireValue(
      /^[a-f0-9]{40}$/.test(value.baseline) && text(value.branch),
      "Issue workflow requires full baseline and feature branch",
    );
  if (!feature && value.origin !== undefined) {
    fields(value.origin, ["kind", "reference"]);
    requireValue(
      ["ticket", "design", "review", "discovery"].includes(value.origin.kind) &&
        text(value.origin.reference),
      "Invalid issue origin",
    );
  }
  if (!feature)
    requireValue(
      value.dependencies === undefined ||
        (strings(value.dependencies) &&
          new Set(value.dependencies).size === value.dependencies.length),
      "dependencies must be unique task IDs",
    );
}


export function validateRequest(params) {
  fields(params, ["operation", "feature_id", "task_id", "payload", "reason"]);
  const { operation, feature_id, task_id, reason } = params;
  let payload = params.payload;
  // Store the exact approved design in Scaffold itself; no second design store.
  if (operation === "init" && payload?.design_ref === "sha256:context") {
    requireValue(text(payload.context), "Approved design context is required");
    payload = { ...payload, design_ref: designReference(payload.context) };
  }
  requireValue(OPERATIONS.includes(operation), "Unsupported operation");
  requireValue(text(feature_id), "feature_id is required");
  requireValue(
    operation === "design-reopen" || operation === "failure-record"
      ? task_id === undefined || text(task_id)
      : taskActions.has(operation)
        ? text(task_id)
        : task_id === undefined,
    "task_id is required only for task transitions/decompose",
  );
  requireValue(
    reasonActions.has(operation) ? text(reason) : reason === undefined,
    "reason is required only for block/fail/retry",
  );
  requireValue(
    inputActions.has(operation) ? payload !== undefined : payload === undefined,
    "payload is required only for init/add/complete/decompose",
  );
  if (operation === "init") {
    definition(payload, true);
    validateDesign(payload);
    requireValue(
      payload.id === feature_id,
      "Feature payload id must match feature_id",
    );
  } else if (operation === "add" || operation === "decompose") {
    requireValue(
      Array.isArray(payload) && payload.length > 0,
      "payload must be a nonempty task array",
    );
    payload.forEach((t) => definition(t));
  } else if (operation === "design-record") {
    fields(payload, ["summary", "verification", "approval", "disposition"]);
    requireValue(
      ["summary", "verification", "approval"].every((k) => text(payload[k])) &&
        ["leaf", "decomposed"].includes(payload.disposition),
      "Invalid approved issue design",
    );
  } else if (operation === "design-reopen") {
    fields(payload, ["reason", "reference"]);
    requireValue(
      text(payload.reason) &&
        (payload.reference === undefined || isReference(payload.reference)),
      "Reason required; a suspension reference must be a ledger reference (sha256:...)",
    );
  } else if (operation === "failure-record") {
    fields(payload, ["code", "message", "tool", "owner", "stage", "cause", "evidence", "next"]);
    requireValue(
      /^[A-Z][A-Z0-9_]{2,63}$/.test(payload.code) && /^[a-z][a-z0-9_]{0,63}$/.test(payload.tool) &&
        ["agent", "user", "bug"].includes(payload.owner) &&
        text(payload.message) && payload.message.length <= 2000 &&
        (payload.stage === undefined || (text(payload.stage) && payload.stage.length <= 64)) &&
        (payload.cause === undefined || (text(payload.cause) && payload.cause.length <= 4000)) &&
        (payload.evidence === undefined || isReference(payload.evidence)) &&
        (payload.next === undefined ||
          (Array.isArray(payload.next) && payload.next.length <= 5 &&
            payload.next.every((step) => text(step) && step.length <= 300))),
      "Invalid failure record",
    );
  } else if (operation === "checkpoint-record") {
    fields(payload, ["commit", "parent", "tree", "reference"]);
    requireValue(
      isCommit(payload.commit) && isCommit(payload.parent) &&
        isCommit(payload.tree) && isReference(payload.reference),
      "Invalid checkpoint",
    );
  } else if (operation === "issue-resume") {
    fields(payload, ["reference", "handoff"]);
    requireValue(
      isReference(payload.reference) && isReference(payload.handoff),
      "Suspension/handoff must be ledger references (sha256:...)",
    );
  } else if (operation === "direction-approve") {
    fields(payload, ["scope_digest", "capabilities"]);
    requireValue(
      /^[a-f0-9]{64}$/.test(payload.scope_digest) &&
        (payload.capabilities === undefined || strings(payload.capabilities)),
      "Invalid direction approval",
    );
  } else if (operation === "attempt-record") {
    fields(payload, ["attempt", "status", "receipt", "base", "tree"]);
    requireValue(
      Number.isSafeInteger(payload.attempt) && payload.attempt >= 1 &&
        ["PASSED", "NEEDS_DESIGN", "BLOCKED"].includes(payload.status) &&
        isReference(payload.receipt) && isCommit(payload.base) && isCommit(payload.tree),
      "Invalid attempt record",
    );
  } else if (operation === "history-foreign") {
    fields(payload, ["from", "to", "source", "commits", "approval"]);
    requireValue(
      isCommit(payload.from) && isCommit(payload.to) &&
        ["user-commits", "upstream-merge"].includes(payload.source) &&
        isReference(payload.approval) && Array.isArray(payload.commits) &&
        payload.commits.length > 0 &&
        payload.commits.every((c) => object(c) && isCommit(c.commit) &&
          Array.isArray(c.parents) && c.parents.length > 0 && c.parents.every(isCommit) &&
          typeof c.subject === "string"),
      "Invalid foreign history range",
    );
  } else if (operation === "history-rewrite") {
    fields(payload, ["old_head", "new_head", "new_base", "history", "verification"]);
    requireValue(
      isCommit(payload.old_head) && isCommit(payload.new_head) && isCommit(payload.new_base) &&
        Array.isArray(payload.history) && isReference(payload.verification),
      "Invalid history rewrite",
    );
  } else if (operation === "artifact-put") {
    requireValue(object(payload), "Artifact must be a JSON object");
  } else if (operation === "artifact-get") {
    fields(payload, ["reference"]);
    requireValue(isReference(payload.reference), "Invalid artifact reference");
  } else if (operation === "complete") {
    fields(payload, [
      "feature_id",
      "task_id",
      "result",
      "source",
      "reference",
      "summary",
    ]);
    requireValue(
      payload.feature_id === feature_id &&
        payload.task_id === task_id &&
        payload.result === "PASSED" &&
        ["source", "reference", "summary"].every((k) => text(payload[k])),
      "Completion requires task-bound PASSED evidence with source, reference and summary",
    );
  }
  return { ...params, payload };
}
function validateTask(task, featureId, taskId) {
  requireValue(
    object(task) &&
      text(task.id) &&
      task.feature_id === featureId &&
      (taskId === undefined || task.id === taskId) &&
      statuses.has(task.status) &&
      (task.parent_id === null || text(task.parent_id)) &&
      strings(task.dependencies) &&
      Array.isArray(task.history),
    "Invalid task response or task identity mismatch",
  );
}
function validateContract(t) {
  requireValue(
    object(t) &&
      text(t.id) &&
      text(t.objective) &&
      strings(t.acceptance_criteria) &&
      t.acceptance_criteria.length > 0 &&
      strings(t.dependencies) &&
      strings(t.constraints) &&
      statuses.has(t.status),
    "Invalid issue contract",
  );
  if (t.design) {
    const { reference, ...body } = t.design;
    const canonical = JSON.stringify(
      Object.fromEntries(
        Object.entries(body).sort(([a], [b]) => a.localeCompare(b)),
      ),
    );
    requireValue(
      ["summary", "verification", "approval"].every((k) => text(t.design[k])) &&
        reference === designReference(canonical),
      "Scoped design digest mismatch",
    );
  }
}
export function validateResponse(data, params) {
  requireValue(object(data), "Expected JSON object");
  requireValue(data.schema_version === 3, "Unsupported schema_version; Scaffold ledger schema 3 required");
  requireValue(!Object.hasOwn(data, "error"), "Error in successful response");
  if (params.operation === "artifact-put") {
    requireValue(isReference(data.reference), "Invalid artifact reference response");
    return;
  }
  if (params.operation === "artifact-get") {
    requireValue(object(data.artifact), "Invalid artifact response");
    return;
  }
  if (
    ["summary", "issue", "select", "design-select"].includes(params.operation)
  ) {
    const v = data.summary;
    requireValue(
      object(v) &&
        v.id === params.feature_id &&
        text(v.design_ref) &&
        ["design", "implement"].includes(v.phase) &&
        Number.isSafeInteger(v.task_revision) &&
        /^[a-f0-9]{64}$/.test(v.state_digest) &&
        /^[a-f0-9]{40}$/.test(v.baseline) &&
        text(v.branch) &&
        object(v.counts),
      "Invalid scoped feature summary",
    );
    if (params.operation !== "summary") {
      requireValue(Object.hasOwn(data, "context"), "Missing scoped context");
      if (data.context !== null) {
        const c = data.context;
        requireValue(
          c.schema === "scaffold.issue-context/v1" &&
            isDeepStrictEqual(c.feature, v) &&
            object(c.issue) &&
            text(c.issue.id) &&
            (params.operation !== "issue" || c.issue.id === params.task_id) &&
            strings(c.issue.acceptance_criteria) &&
            statuses.has(c.issue.status) &&
            ["ancestors", "prerequisites", "children"].every((k) =>
              Array.isArray(c[k]),
            ),
          "Invalid scoped issue context",
        );
        [c.issue, ...c.ancestors, ...c.prerequisites, ...c.children].forEach(
          validateContract,
        );
      } else
        requireValue(params.operation !== "issue", "Missing requested issue");
    }
    return;
  }
  const needsFeature = [
    "delivery-record",
    "init",
    "add",
    "list",
    "decompose",
    "design-record",
    "design-finish",
    "design-reopen",
    "checkpoint-record",
    "issue-resume",
    "direction-approve",
    "attempt-record",
    "history-foreign",
    "history-rewrite",
    "failure-record",
  ].includes(params.operation);
  if (needsFeature) {
    requireValue(
      object(data.feature) &&
        data.feature.id === params.feature_id &&
        object(data.feature.tasks),
      "Invalid feature response or feature identity mismatch",
    );
    validateDesign(data.feature);
    requireValue(
      object(data.feature.workflow),
      "Recursive issue graph required",
    );
    {
      requireValue(
        data.schema_version === 3 &&
          /^[a-f0-9]{64}$/.test(data.feature.direction_scope) &&
          isCommit(data.feature.head) && isCommit(data.feature.base) && Array.isArray(data.feature.history) &&
          data.feature.workflow.kind === "recursive-issues/v1" &&
          ["design", "implement"].includes(data.feature.workflow.phase) &&
          data.feature.tasks[data.feature.workflow.root_id] &&
          data.feature.original_baseline === data.feature.baseline &&
          /^[a-f0-9]{40}$/.test(data.feature.baseline) &&
          text(data.feature.branch),
        "Unsupported issue workflow response",
      );
      for (const task of Object.values(data.feature.tasks))
        for (const d of task.designs ?? []) {
          const { reference, ...body } = d;
          const canonical = JSON.stringify(
            Object.fromEntries(
              Object.entries(body).sort(([a], [b]) => a.localeCompare(b)),
            ),
          );
          requireValue(
            ["summary", "verification", "approval"].every((k) => text(d[k])) &&
              ["leaf", "decomposed"].includes(d.disposition) &&
              strings(d.children) &&
              reference === designReference(canonical),
            "Issue design digest mismatch",
          );
        }
    }
    for (const [id, task] of Object.entries(data.feature.tasks))
      validateTask(task, params.feature_id, id);
  }
  if (!needsFeature) {
    validateTask(data.task, params.feature_id, params.task_id);
    const expected = {
      start: "in_progress",
      complete: "completed",
      block: "blocked",
      fail: "failed",
    }[params.operation];
    requireValue(
      expected
        ? data.task.status === expected
        : ["pending", "decomposed"].includes(data.task.status),
      "Unexpected transition status",
    );
  }
}


export function approvedIssue(feature, binding) {
  const task = feature.tasks[binding.taskId];
  requireValue(
    feature.workflow.phase === "implement" && task?.designs?.length === 1,
    "Entire issue graph must finish design before execution",
  );
  return task;
}
export function issueDesignRequirements(task) {
  const d = task.designs.at(-1);
  return (
    "\n\nApproved issue design " +
    d.reference +
    "\n" +
    d.summary +
    "\nVerification: " +
    d.verification +
    "\nApproval record: " +
    d.approval
  );
}
// Persisted policy is authoritative; callers supply only additional scope. Keep
// this idempotent for existing callers that already supply the canonical text.
export function issueRequirements(task, additional) {
  requireValue(
    typeof additional === "string",
    "Issue requirements must be a string",
  );
  const missing = [
    ...task.acceptance_criteria,
    ...task.constraints,
    issueDesignRequirements(task),
  ].filter((text) => !additional.includes(text));
  return additional + (missing.length ? "\n\n" + missing.join("\n") : "");
}

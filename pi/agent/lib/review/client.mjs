// Review CLI request, invocation and result contract shared by both entry points.
const requireValue = (ok, message) => {
  if (!ok) throw new Error(message);
};

export function reviewRequest(repository, baseRef, headRef, requirementsPath) {
  return { schema: "review.request/v1", repository_path: repository,
    base_ref: baseRef, head_ref: headRef, requirements: requirementsPath };
}

export function reviewExecutable() {
  return process.env.REVIEW_CLI_BIN ?? "review-cli";
}

export function reviewStep(requestPath, request, requirements, settings, {
  program = reviewExecutable(), prefixArgs = [], ledgerPath,
} = {}) {
  const { model, budget, turns, limits } = settings;
  const wallClock = ["--wall-clock-budget-secs", String(budget)];
  const maxTurns = ["--max-turns", String(turns)];
  // Preserve each entry point's established argv, including retained delivery receipts.
  return {
    program,
    args: [...prefixArgs, "run", "--request", requestPath, "--format", "json", "--model", model,
      ...(ledgerPath === undefined ? [...maxTurns, ...wallClock] : [...wallClock, ...maxTurns, "--ledger", ledgerPath]),
      ...limits],
    files: [[requestPath, JSON.stringify(request)], [request.requirements, requirements]],
  };
}

export function deliveryReviewSettings(args) {
  const model = args.reviewModel ?? "opencode/gpt-6.1-sol";
  requireValue(
    typeof model === "string" &&
      model.trim() &&
      !model.includes("\0") &&
      model.length <= 512,
    "Invalid review model",
  );
  for (const field of [
    "reviewWallClockBudgetSecs",
    "reviewMaxTurns",
    "reviewMaxToolCalls",
    "reviewMaxRepeatedActions",
    "reviewMaxCompletionAttempts",
  ]) {
    requireValue(
      args[field] == null ||
        (Number.isSafeInteger(args[field]) && args[field] > 0),
      "Invalid " + field,
    );
  }
  requireValue(
    args.reviewMaxCostUsd == null ||
      (typeof args.reviewMaxCostUsd === "number" &&
        Number.isFinite(args.reviewMaxCostUsd) &&
        args.reviewMaxCostUsd >= 0),
    "Invalid reviewMaxCostUsd",
  );
  const limits = [];
  for (const [field, flag] of [
    ["reviewMaxCostUsd", "--max-cost-usd"],
    ["reviewMaxToolCalls", "--max-tool-calls"],
    ["reviewMaxRepeatedActions", "--max-repeated-actions"],
    ["reviewMaxCompletionAttempts", "--max-completion-attempts"],
  ])
    if (args[field] != null) limits.push(flag, String(args[field]));
  return { model, budget: args.reviewWallClockBudgetSecs ?? 180, turns: args.reviewMaxTurns ?? 20, limits };
}

export function validateReviewResult(value, code) {
  const expected = { APPROVED: 0, CHANGES_REQUESTED: 1, INDETERMINATE: 3 };
  requireValue(
    value?.schema === "review.result/v1" &&
      Object.hasOwn(expected, value.status) &&
      expected[value.status] === code &&
      Array.isArray(value.findings) &&
      typeof value.reason === "string" &&
      value.reason.trim() &&
      typeof value.review_id === "string" &&
      value.review_id.trim() &&
      typeof value.completed_at === "string" &&
      value.completed_at.trim(),
    "Review schema/status/exit code mismatch",
  );
  requireValue(
    value.status === "INDETERMINATE" || value.reason === "REVIEW_COMPLETED",
    "Review did not complete",
  );
  for (const finding of value.findings)
    requireValue(
      finding &&
        typeof finding.blocking === "boolean" &&
        typeof finding.message === "string" &&
        finding.message.trim() &&
        ["high", "medium", "low"].includes(finding.severity) &&
        (finding.path == null || typeof finding.path === "string") &&
        (finding.line == null ||
          (Number.isInteger(finding.line) && finding.line >= 0)) &&
        (finding.recommendation == null ||
          typeof finding.recommendation === "string"),
      "Invalid Review finding",
    );
  if (value.obligation_assessments !== undefined) {
    const assessments = value.obligation_assessments;
    requireValue(
      Array.isArray(assessments) &&
        new Set(assessments.map((a) => a.obligation_id)).size ===
          assessments.length &&
        assessments.every(
          (a) =>
            a &&
            typeof a.obligation_id === "string" &&
            a.obligation_id.trim() &&
            ["verified", "unresolved", "not_applicable"].includes(
              a.disposition,
            ) &&
            typeof a.evidence === "string" &&
            a.evidence.trim(),
        ),
      "Invalid independent obligation assessments",
    );
  }
  const blocking = value.findings.some((f) => f.blocking);
  requireValue(
    value.status === "INDETERMINATE" ||
      (value.status === "APPROVED" ? !blocking : blocking),
    "Review verdict contradicts findings",
  );
  return value;
}

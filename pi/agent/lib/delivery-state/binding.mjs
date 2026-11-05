export function validateBinding(binding) {
  if (
    !binding ||
    Object.keys(binding).some(
      (k) => !["featureId", "taskId", "designRef"].includes(k),
    ) ||
    ["featureId", "taskId", "designRef"].some(
      (k) => typeof binding[k] !== "string" || !binding[k].trim(),
    )
  ) {
    throw new Error("task requires featureId, taskId and designRef");
  }
}

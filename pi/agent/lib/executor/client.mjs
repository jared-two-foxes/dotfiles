// Executor CLI input, invocation and result contract.
export function executorInput(input) {
  const operations = JSON.parse(input);
  if (!Array.isArray(operations.operations)) throw new Error("Invalid Executor operations");
  return operations;
}

export function executorExecutable() {
  return process.env.EXECUTOR_BIN ?? "executor";
}

export function executorStep(requestPath, input, program = executorExecutable()) {
  return {
    program,
    args: ["apply", requestPath],
    files: [[requestPath, JSON.stringify(input)]],
  };
}

export function validateExecutorResult(result, code, expectedOperations) {
  if (typeof result?.success !== "boolean" ||
      !Number.isInteger(result.operations_applied) ||
      result.operations_applied < 0 ||
      code !== (result.success ? 0 : 1) ||
      (result.success && result.operations_applied !== expectedOperations)) {
    throw new Error("Executor outcome/exit code/count mismatch");
  }
}

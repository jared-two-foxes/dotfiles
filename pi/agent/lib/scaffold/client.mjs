// Minimal Scaffold CLI client for shared modules. Validates requests and responses with the
// shared contracts. It has no authorization hooks; extensions use their adapter for guarded
// lifecycle operations.
import { realpath } from "node:fs/promises";
import { invoke } from "./process.mjs";
import { validateRequest, validateResponse } from "./contracts.mjs";

/**
 * Run one Scaffold operation in `repository` and return its parsed response.
 * Throws an Error carrying `.code === "UNKNOWN_FEATURE"` when Scaffold has no such open feature.
 */
export async function scaffoldCall(repository, params, options = {}) {
  const { operation, feature_id, task_id, reason, payload } = validateRequest(params);
  const args = [operation, "--feature=" + feature_id];
  if (task_id !== undefined) args.push("--task=" + task_id);
  if (reason !== undefined) args.push("--reason=" + reason);
  if (payload !== undefined) args.push("--input", "-");
  const response = await (options.invokeScaffold ?? invoke)("scaffold", args, {
    cwd: await realpath(repository),
    input: payload === undefined ? "" : JSON.stringify(payload),
  });
  if (response.code !== 0) {
    let detail = "";
    try {
      detail = JSON.parse(response.stderr).error ?? "";
    } catch {
      detail = String(response.stderr ?? "").slice(0, 500);
    }
    throw Object.assign(new Error("Scaffold " + operation + " failed: " + detail), {
      code: /Unknown feature/.test(detail) ? "UNKNOWN_FEATURE" : "SCAFFOLD_FAILED",
      detail,
    });
  }
  const data = JSON.parse(response.stdout);
  validateResponse(data, params);
  return data;
}

/** Open feature ids in the repository, from `scaffold features`. */
export async function openFeatureIds(repository, options = {}) {
  const response = await (options.invokeScaffold ?? invoke)("scaffold", ["features"], {
    cwd: await realpath(repository),
    input: "",
  });
  if (response.code !== 0) throw new Error("Cannot list Scaffold features: " + String(response.stderr).slice(0, 300));
  const data = JSON.parse(response.stdout);
  if (data?.schema_version !== 3 || !Array.isArray(data.features))
    throw new Error("Unsupported Scaffold features response; Scaffold ledger schema 3 required");
  return data.features.map((f) => f.id);
}

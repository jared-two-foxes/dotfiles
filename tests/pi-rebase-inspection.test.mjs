import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { git } from "../pi/agent/lib/git/tree.mjs";
import { retainFeatureEvidence } from "../pi/agent/lib/evidence/store.mjs";
import {
  createRebaseInspectionTool,
  inspectRebaseEvidence,
} from "../pi/agent/extensions/execution-recovery/rebase-inspection.mjs";

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-rebase-inspect-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  git(directory, ["init", "-q", "-b", "feature/inspect"]);
  git(directory, ["config", "user.name", "Test"]);
  git(directory, ["config", "user.email", "test@example.invalid"]);
  await writeFile(path.join(directory, "source.txt"), "base\n");
  git(directory, ["add", "."]);
  git(directory, ["commit", "-qm", "baseline"]);
  return { directory };
}

test("rebase inspection rejects malformed references and missing evidence in either namespace", async t => {
  const context = await fixture(t);
  for (const reference of [
    "", "unknown:sha256:" + "a".repeat(64), "pi-evidence:sha256:../escape",
    "pi-evidence:sha256:" + "a".repeat(64),
    "pi-feature-evidence:sha256:" + "a".repeat(64),
  ]) {
    const result = await inspectRebaseEvidence({ reference }, context);
    assert.equal(result.ok, false, JSON.stringify(result));
  }
});

test("feature discovery filters unrelated receipts and explicit unrelated references fail", async t => {
  const context = await fixture(t);
  assert.deepEqual(await inspectRebaseEvidence({}, context), { ok: true, results: [] });
  const reference = await retainFeatureEvidence(context.directory, { kind: "feature-authorization" });
  assert.deepEqual(await inspectRebaseEvidence({ featureId: "F" }, context),
    { ok: true, results: [] });
  const result = await inspectRebaseEvidence({ reference }, context);
  assert.equal(result.ok, false);
  assert.match(result.message, /not a matching feature rebase reconciliation/);
});

test("one native inspection tool preserves context, stale applicability, consumed attempts and errors", async () => {
  const Type = {
    String: options => ({ type: "string", ...options }),
    Optional: schema => ({ ...schema, optional: true }),
    Object: (properties, options) => ({ properties, ...options }),
  };
  const params = { reference: "pi-evidence:sha256:" + "a".repeat(64) };
  const controller = new AbortController();
  for (const inspected of [
    { ok: true, results: [{ kind: "rebase-handoff", applicable: false, consumedAttempts: 3 }] },
    { ok: true, results: [{ kind: "reconciliation", applicable: true }] },
    { ok: false, message: "Evidence digest mismatch" },
  ]) {
    const tool = createRebaseInspectionTool(Type, async (args, context) => {
      assert.equal(args, params);
      assert.equal(context.directory, "/session");
      assert.equal(context.abort, controller.signal);
      return inspected;
    });
    assert.equal(tool.name, "inspect_rebase_evidence");
    assert.equal(tool.parameters.additionalProperties, false);
    assert.deepEqual(Object.keys(tool.parameters.properties).sort(), ["featureId", "reference"]);
    const result = await tool.execute("id", params, controller.signal, undefined, { cwd: "/session" });
    assert.deepEqual(JSON.parse(result.content[0].text), inspected);
    assert.equal(result.details, inspected);
    assert.equal(result.isError, !inspected.ok);
  }
  const index = await readFile(new URL("../pi/agent/extensions/execution-recovery/index.ts", import.meta.url), "utf8");
  assert.match(index, /pi\.registerTool\(createRebaseInspectionTool\(Type\)\)/);
  assert.doesNotMatch(index, /name: "inspect_(?:task_rebase_recovery|rebase_reconciliation)"/);
});

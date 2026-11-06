import assert from "node:assert/strict";
import { test } from "node:test";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = file => readFile(path.join(root, file), "utf8");

test("legacy criteria-stack prompts are retired without deleting standalone prompts", async () => {
  const obsolete = [
    "explore-criterion",
    "implement-criterion",
    "implement-criterion-direct",
    "implement-criterion-refactor",
    "test-criterion",
    "review-test-quality",
    "review-singlepass",
  ];
  for (const name of obsolete) {
    await assert.rejects(
      access(path.join(root, "prompts", name + ".prompt.md")),
      { code: "ENOENT" },
      name + " must not reintroduce the deleted criterion-frame pipeline",
    );
  }

  // Independent ticket/design/test prompts are not themselves criteria-stack callers.
  for (const name of ["review-ticket", "plan-narrow", "test"]) {
    await access(path.join(root, "prompts", name + ".prompt.md"));
  }
});

test("feature workflow documents one task graph and distinct Pi skill boundaries", async () => {
  const overview = await read("workflow-overview.md");
  for (const fragment of [
    "/skill:init-feature",
    "/skill:design",
    "/skill:implement-task",
    "/skill:feature-delivery",
    "approve_feature_direction",
    "design-finish",
    "validate_feature",
    "scaffold_tasks",
    ".scaffold/tasks.json",
    ".scaffold/.tasks.lock",
    "Conductor",
  ]) {
    assert.ok(overview.includes(fragment), "Missing workflow guidance: " + fragment);
  }
  assert.match(overview, /does not start tasks, alter application source/);
  assert.match(overview, /merges remain human-owned/);
  assert.match(overview, /retired.*not alternate work-tracking interfaces/);
});

test("Scaffold guidance provides only task-state CLI inspection and no stack commands", async () => {
  const documents = [
    await read("workflow-overview.md"),
    await read("pi/agent/skills/scaffold/SKILL.md"),
    await read("pi/agent/extensions/scaffold/README.md"),
  ];
  for (const body of documents) {
    assert.match(body, /scaffold tasks summary --feature/);
    assert.match(body, /scaffold tasks issue --feature/);
    assert.match(body, /scaffold tasks design-select/);
    assert.match(body, /scaffold tasks select --feature/);
    assert.match(body, /scaffold_tasks/);
    for (const [, commands] of body.matchAll(/```(?:sh|bash|shell)?\n([\s\S]*?)```/g)) {
      assert.doesNotMatch(commands, /\bscaffold\s+(?:stack|status)\b/);
    }
  }
});

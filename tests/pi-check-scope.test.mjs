import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  BROAD_CHECK_JUSTIFICATION_INVALID,
  BROAD_CHECK_UNJUSTIFIED,
  broadChecks,
  classifyBroadCheck,
  parseJustifications,
  requireBroadCheckJustifications,
} from "../pi/agent/lib/verification/check-scope.mjs";
import { executeAndReview } from "../pi/agent/extensions/execute-and-review/adapter.mjs";

const SHA = "a".repeat(40);
const REASON = "The runner cannot select the necessary tests individually";

// Bare, whole-suite commands: nothing narrows the run.
const broad = [
  [["cargo", "test"], "cargo test"],
  [["cargo", "test", "--workspace"], "cargo test"],
  [["cargo", "test", "--all-targets", "--no-fail-fast", "-q"], "cargo test"],
  [["cargo", "+nightly", "test"], "cargo test"],
  [["cargo", "test", "--", "--nocapture"], "cargo test"],
  [["/usr/local/bin/cargo", "test"], "cargo test"],
  [["C:\\tools\\cargo.exe", "test"], "cargo test"],
  [["cargo", "nextest", "run"], "cargo nextest run"],
  [["npm", "test"], "npm test"],
  [["npm", "run", "test"], "npm test"],
  [["npm", "t", "--silent"], "npm test"],
  [["pnpm", "test"], "pnpm test"],
  [["yarn", "run", "test"], "yarn test"],
  [["pytest"], "pytest"],
  [["pytest", "-q"], "pytest"],
  [["py.test", "-x", "--tb=short"], "pytest"],
  [["python", "-m", "pytest"], "pytest"],
  [["python3", "-m", "pytest", "-q"], "pytest"],
  [["go", "test", "./..."], "go test ./..."],
  [["go", "test", "-count=1", "./..."], "go test ./..."],
  [["dotnet", "test"], "dotnet test"],
  [["dotnet", "test", "--no-build"], "dotnet test"],
  [["node", "--test"], "node --test"],
  [["vitest"], "vitest"],
  [["vitest", "run"], "vitest"],
  [["jest", "--ci"], "jest"],
  [["mocha"], "mocha"],
  [["npx", "--yes", "jest"], "jest"],
  [["pnpm", "exec", "vitest", "run"], "vitest"],
];

// Targeted commands: every one of these must stay allowed without justification,
// including each one used by the task-delivery tests and documented in the skills.
const targeted = [
  ["cargo", "check"],
  ["cargo", "test", "--lib", "invoices::"],
  ["cargo", "test", "--lib"],
  ["cargo", "test", "--test", "regression"],
  ["cargo", "test", "--test=regression"],
  ["cargo", "test", "--test", "cli_integration", "quote_activity"],
  ["cargo", "test", "-p", "affected-crate", "regression_name"],
  ["cargo", "test", "-p", "affected-crate"],
  ["cargo", "test", "--lib", "invoices::", "--", "--exact"],
  ["cargo", "test", "status"],
  ["cargo", "test", "--", "some_filter"],
  ["cargo", "nextest", "run", "-E", "test(parse)"],
  ["node", "--test", "tests/affected.test.mjs"],
  ["node", "--test", "--test-name-pattern", "parser"],
  [process.execPath, "-e", 'console.log("compiled")'],
  ["npm", "test", "--", "tests/a.test.js"],
  ["npm", "run", "test", "--workspace", "pkg"],
  ["pnpm", "--filter", "pkg", "test"],
  ["npm", "run", "lint"],
  ["pytest", "tests/test_invoices.py"],
  ["pytest", "-k", "invoice"],
  ["pytest", "-m", "unit"],
  ["pytest", "--lf"],
  ["python", "-m", "pytest", "tests/test_a.py"],
  ["go", "test", "./pkg/invoices/..."],
  ["go", "test", "-run", "TestInvoice", "./..."],
  ["go", "test", "-run=TestInvoice", "./..."],
  ["go", "test"],
  ["dotnet", "test", "--filter", "FullyQualifiedName~Invoice"],
  ["dotnet", "test", "tests/Invoices.Tests.csproj"],
  ["vitest", "run", "src/invoices.test.ts"],
  ["vitest", "-t", "invoice"],
  ["jest", "-t", "invoice"],
  ["jest", "src/invoices"],
  ["jest", "--findRelatedTests", "src/a.ts"],
  ["mocha", "test/invoices.spec.js"],
  ["mocha", "--grep", "invoice"],
  // Fixtures and wrappers that are not recognized runners are never blocked.
  ["fixture", "test"],
  ["test"],
  ["true"],
  ["sh", "-c", "cargo test --test regression"],
  ["tool", "a b", "$(literal)", ";"],
];

test("bare whole-suite commands are recognized across runners", () => {
  for (const [command, runner] of broad)
    assert.equal(classifyBroadCheck(command), runner, command.join(" "));
});

test("targeted, unknown and malformed commands are never flagged", () => {
  for (const command of targeted)
    assert.equal(classifyBroadCheck(command), null, command.join(" "));
  for (const command of [undefined, null, [], "cargo test", {}])
    assert.equal(classifyBroadCheck(command), null);
});

test("broadChecks reports each offending check by name and runner", () => {
  const checks = [
    { name: "compile", command: ["cargo", "check"] },
    { name: "tests", command: ["cargo", "test"] },
    { name: "focused", command: ["cargo", "test", "--lib", "invoices::"] },
    { name: "python", command: ["pytest", "-q"] },
  ];
  assert.deepEqual(broadChecks(checks).map(({ name, runner }) => [name, runner]), [
    ["tests", "cargo test"],
    ["python", "pytest"],
  ]);
});

test("justifications are validated against the plan's check names", () => {
  const checks = [{ name: "tests", command: ["cargo", "test"] }, { name: "build", command: ["cargo", "check"] }];
  assert.equal(parseJustifications(undefined, checks).size, 0);
  assert.equal(parseJustifications([{ check: "tests", reason: `  ${REASON}  ` }], checks).get("tests"), REASON);
  const bad = [
    "not an array",
    Array.from({ length: 65 }, () => ({ check: "tests", reason: REASON })),
    [null],
    [{ check: "tests" }],
    [{ check: "tests", reason: REASON, extra: 1 }],
    [{ check: 7, reason: REASON }],
    [{ check: "missing", reason: REASON }],
    [{ check: "tests", reason: REASON }, { check: "tests", reason: REASON }],
    [{ check: "tests", reason: "too short" }],
    [{ check: "tests", reason: " ".repeat(40) }],
    [{ check: "tests", reason: REASON + "\0" }],
    [{ check: "tests", reason: "x".repeat(2001) }],
  ];
  for (const raw of bad)
    assert.throws(() => parseJustifications(raw, checks), (error) => error.code === BROAD_CHECK_JUSTIFICATION_INVALID);
});

test("an unjustified bare full-suite check is rejected with actionable guidance", () => {
  const args = { checks: [{ name: "compile", command: ["cargo", "check"] }, { name: "tests", command: ["cargo", "test"] }] };
  assert.throws(
    () => requireBroadCheckJustifications(args),
    (error) => {
      assert.equal(error.code, BROAD_CHECK_UNJUSTIFIED);
      assert.deepEqual(error.findings.map((f) => f.name), ["tests"]);
      assert.match(error.message, /"tests" \(cargo test\)/);
      assert.match(error.message, /validate_feature/);
      assert.match(error.message, /broadCheckJustifications/);
      assert.match(error.message, /No source operations were applied/);
      return true;
    },
  );
});

test("a recorded reason, or a targeted plan, passes", () => {
  const broadPlan = [{ name: "tests", command: ["pytest"] }];
  assert.doesNotThrow(() => requireBroadCheckJustifications({
    checks: broadPlan, broadCheckJustifications: [{ check: "tests", reason: REASON }],
  }));
  assert.doesNotThrow(() => requireBroadCheckJustifications({
    checks: [{ name: "tests", command: ["pytest", "tests/test_a.py"] }],
  }));
  // A reason for a check that is not broad is harmless as long as the name exists.
  assert.doesNotThrow(() => requireBroadCheckJustifications({
    checks: [{ name: "tests", command: ["pytest", "tests/test_a.py"] }],
    broadCheckJustifications: [{ check: "tests", reason: REASON }],
  }));
  // Every broad check needs its own reason.
  assert.throws(() => requireBroadCheckJustifications({
    checks: [{ name: "a", command: ["pytest"] }, { name: "b", command: ["npm", "test"] }],
    broadCheckJustifications: [{ check: "a", reason: REASON }],
  }), (error) => error.code === BROAD_CHECK_UNJUSTIFIED && error.findings.length === 1 && error.findings[0].name === "b");
});

// The adapter rejects an unjustified first attempt before touching any repository.
function firstAttempt(extra = {}) {
  return {
    task: { featureId: "F", taskId: "T", designRef: "design" },
    baseRef: SHA,
    requirements: "One behavior",
    input: '{"operations":[]}',
    checks: [{ name: "tests", command: ["cargo", "test"] }],
    ...extra,
  };
}

test("execute_and_review blocks an unjustified first attempt with a structured reason", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-check-scope-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const result = await executeAndReview(firstAttempt(), { directory: dir });
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.stage, "PRECHECK");
  assert.equal(result.reason, BROAD_CHECK_UNJUSTIFIED);
  assert.deepEqual(result.broadChecks.map((c) => c.name), ["tests"]);
  assert.match(result.message, /whole test suite/);
});

test("execute_and_review rejects a malformed justification with its own reason", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-check-scope-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const result = await executeAndReview(
    firstAttempt({ broadCheckJustifications: [{ check: "typo", reason: REASON }] }),
    { directory: dir },
  );
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.reason, BROAD_CHECK_JUSTIFICATION_INVALID);
});

test("a justified or targeted first attempt proceeds past the scope check", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-check-scope-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  // Not a Git repository, so it stops later at repository resolution: the scope
  // check itself must not be what blocks it.
  for (const args of [
    firstAttempt({ broadCheckJustifications: [{ check: "tests", reason: REASON }] }),
    firstAttempt({ checks: [{ name: "tests", command: ["cargo", "test", "--lib", "invoices::"] }] }),
  ]) {
    const result = await executeAndReview(args, { directory: dir });
    assert.equal(result.status, "BLOCKED");
    assert.ok(!String(result.reason).startsWith("BROAD_CHECK_"), JSON.stringify(result));
  }
});

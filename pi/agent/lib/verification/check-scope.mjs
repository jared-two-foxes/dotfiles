// Enforce "targeted checks for tasks; the full suite only for validate_feature".
//
// A task's first verification plan may not contain a bare full-suite test command
// unless the caller records why that breadth is unavoidable. This is a guardrail
// against accidental cost, not a security boundary: shell-wrapped commands such as
// `sh -c "cargo test"` are not inspected, and any argument that could select tests
// (a path, filter, package, or a flag's value) counts as targeting. When in doubt a
// command is treated as targeted, because blocking a legitimate check costs more
// than missing a broad one.
const MIN_REASON = 20;
const MAX_REASON = 2000;

export const BROAD_CHECK_UNJUSTIFIED = "BROAD_CHECK_UNJUSTIFIED";
export const BROAD_CHECK_JUSTIFICATION_INVALID = "BROAD_CHECK_JUSTIFICATION_INVALID";

const program = (value) => String(value).split(/[\\/]/).at(-1).replace(/\.(exe|cmd|bat)$/i, "");
const isFlag = (arg) => arg.startsWith("-");
const flagName = (arg) => arg.split("=")[0];
const set = (...values) => new Set(values);

// True when nothing narrows the run: every argument before `--` is a flag that is not
// a selector, and anything after `--` is a flag (a bare value there is a test filter).
function unselective(rest, selectors) {
  const dash = rest.indexOf("--");
  const head = dash < 0 ? rest : rest.slice(0, dash);
  const tail = dash < 0 ? [] : rest.slice(dash + 1);
  return (
    head.every((arg) => isFlag(arg) && !selectors.has(flagName(arg))) &&
    tail.every(isFlag)
  );
}

const CARGO = set("-p", "--package", "--lib", "--bin", "--bins", "--example", "--examples",
  "--test", "--tests", "--bench", "--benches", "--doc", "-E", "--filter-expr", "--partition");
const NODE_PM = set("-w", "--workspace", "--filter", "-F", "--prefix", "--dir", "-C", "--cwd");
const PYTEST = set("-k", "-m", "--lf", "--last-failed", "--deselect", "--ignore", "--ignore-glob");
const DOTNET = set("--filter", "--project", "--solution", "--list-tests", "-t");
const NODE_TEST = set("--test-name-pattern", "--test-only", "--test-shard");
const JS_RUNNER = set("-t", "--testNamePattern", "--testPathPattern", "--findRelatedTests",
  "--onlyChanged", "-o", "--lastCommit", "--changedSince", "--shard", "--selectProjects",
  "--runTestsByPath", "--onlyFailures", "-f", "--changed", "--related", "--project",
  "-g", "--grep", "--fgrep", "--spec");
const NONE = set();

// Each recognizer returns a runner label when the command is a bare full-suite run.
const recognizers = [
  (t) => {
    if (program(t[0]) !== "cargo") return;
    let rest = t.slice(1);
    if (rest[0]?.startsWith("+")) rest = rest.slice(1);
    if (rest[0] === "test" && unselective(rest.slice(1), CARGO)) return "cargo test";
    if (rest[0] === "nextest" && rest[1] === "run" && unselective(rest.slice(2), CARGO))
      return "cargo nextest run";
  },
  (t) => {
    if (!["npm", "pnpm", "yarn", "bun"].includes(program(t[0]))) return;
    const rest = t.slice(1);
    const index = ["test", "t"].includes(rest[0]) ? 1
      : ["run", "run-script"].includes(rest[0]) && rest[1] === "test" ? 2 : 0;
    if (index && unselective(rest.slice(index), NODE_PM)) return `${program(t[0])} test`;
  },
  (t) => {
    const name = program(t[0]);
    const rest = ["pytest", "py.test"].includes(name) ? t.slice(1)
      : ["python", "python3", "py"].includes(name) && t[1] === "-m" && t[2] === "pytest"
        ? t.slice(3) : undefined;
    if (rest && unselective(rest, PYTEST)) return "pytest";
  },
  (t) => {
    if (program(t[0]) !== "go" || t[1] !== "test") return;
    const rest = t.slice(2);
    if (rest.includes("./...") && !rest.some((a) => /^--?run(=|$)/.test(a))) return "go test ./...";
  },
  (t) => {
    if (program(t[0]) === "dotnet" && t[1] === "test" && unselective(t.slice(2), DOTNET))
      return "dotnet test";
  },
  (t) => {
    if (program(t[0]) !== "node" || !t.includes("--test")) return;
    const rest = t.slice(1).filter((arg) => arg !== "--test");
    if (unselective(rest, NODE_TEST)) return "node --test";
  },
  (t) => {
    let rest = t;
    // Launchers that merely run a locally installed tool.
    if (["npx", "bunx"].includes(program(rest[0]))) rest = rest.slice(1).filter((a, i, all) =>
      !(isFlag(a) && all.slice(0, i).every(isFlag)));
    else if (["pnpm", "yarn"].includes(program(rest[0])) && rest[1] === "exec") rest = rest.slice(2);
    const name = program(rest[0] ?? "");
    if (!["vitest", "jest", "mocha", "ava"].includes(name)) return;
    const args = name === "vitest" && rest[1] === "run" ? rest.slice(2) : rest.slice(1);
    if (unselective(args, JS_RUNNER)) return name;
  },
];

// The runner label if this command runs a whole test suite with nothing narrowing it.
export function classifyBroadCheck(command) {
  if (!Array.isArray(command) || !command.length) return null;
  for (const recognize of recognizers) {
    const runner = recognize(command);
    if (runner) return runner;
  }
  return null;
}

export function broadChecks(checks) {
  return checks.flatMap((check) => {
    const runner = classifyBroadCheck(check.command);
    return runner ? [{ name: check.name, runner, command: check.command }] : [];
  });
}

function invalid(message, code = BROAD_CHECK_JUSTIFICATION_INVALID, findings) {
  return Object.assign(new Error(message), { code, ...(findings ? { findings } : {}) });
}

// Validate the caller's recorded reasons against the plan's check names.
export function parseJustifications(raw, checks) {
  if (raw === undefined) return new Map();
  if (!Array.isArray(raw) || raw.length > 64)
    throw invalid("broadCheckJustifications must be an array of at most 64 {check, reason} entries");
  const names = new Set(checks.map((c) => c.name));
  const reasons = new Map();
  for (const entry of raw) {
    const shapeOk = entry && typeof entry === "object" && !Array.isArray(entry) &&
      Object.keys(entry).every((k) => ["check", "reason"].includes(k));
    if (!shapeOk || typeof entry.check !== "string" || typeof entry.reason !== "string")
      throw invalid("Each broadCheckJustifications entry must be exactly {check, reason}");
    if (!names.has(entry.check))
      throw invalid(`broadCheckJustifications names "${entry.check}", which is not one of the plan's checks`);
    if (reasons.has(entry.check))
      throw invalid(`broadCheckJustifications has more than one entry for "${entry.check}"`);
    const reason = entry.reason.trim();
    if (reason.length < MIN_REASON || entry.reason.length > MAX_REASON || entry.reason.includes("\0"))
      throw invalid(`The reason for "${entry.check}" must explain why the whole suite is needed ` +
        `(${MIN_REASON} to ${MAX_REASON} characters)`);
    reasons.set(entry.check, reason);
  }
  return reasons;
}

// Throw unless every bare full-suite check in a new verification plan is justified.
export function requireBroadCheckJustifications(args) {
  const checks = args.checks;
  const reasons = parseJustifications(args.broadCheckJustifications, checks);
  const unjustified = broadChecks(checks).filter((check) => !reasons.has(check.name));
  if (!unjustified.length) return;
  const list = unjustified.map((c) => `"${c.name}" (${c.runner})`).join(", ");
  throw invalid(
    `Task checks should be targeted; ${list} would run the whole test suite. ` +
      "Narrow each with a test name, file, package or filter (the full suite is reserved for validate_feature), " +
      "or, if the runner cannot select the necessary tests, record why with " +
      'broadCheckJustifications: [{ "check": "<name>", "reason": "<why the whole suite is required>" }]. ' +
      "No source operations were applied.",
    BROAD_CHECK_UNJUSTIFIED,
    unjustified,
  );
}

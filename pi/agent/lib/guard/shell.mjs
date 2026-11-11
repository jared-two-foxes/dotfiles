// Shell command policy for repositories under an active Scaffold delivery.
//
// Default-deny: a command passes only if it is provably read-only. A denylist cannot win against shell syntax
// (substitution, redirection, interpreters, wrappers), so anything not understood is refused.
//
// This is a best-effort policy for a cooperative-but-fallible agent. It is NOT a sandbox: it does not stop a
// process that is already running arbitrary code, and it cannot see what an allowed program does internally.
// Pair it with an OS sandbox for isolation. It only restricts; it never grants permission.
//
// Verdicts: { decision: "pass" } | { decision: "ask", reason } | { decision: "deny", reason }

const PASS = { decision: "pass" };
const deny = (reason) => ({ decision: "deny", reason });
const ask = (reason) => ({ decision: "ask", reason });

export const GUARD_HINT =
  "While a Scaffold delivery is active, source changes and checks go through the delivery tools " +
  "(execute_and_review). To work outside the guard the user can set PI_DELIVERY_GUARD=off.";

/* ------------------------------------------------------------------------------------------------ tokenizer */

/**
 * Split a POSIX-ish command line into segments of words, refusing anything that can run or write something we
 * cannot see: substitution, subshells, input redirection, and redirection to anything but /dev/null.
 * @returns {{ ok: true, segments: string[][] } | { ok: false, reason: string }}
 */
export function tokenize(command) {
  const segments = [];
  let words = [];
  let cur = "";
  let started = false;
  const endWord = () => { if (started) { words.push(cur); cur = ""; started = false; } };
  const endSegment = () => { endWord(); if (words.length) segments.push(words); words = []; };
  const fail = (reason) => ({ ok: false, reason });
  const n = command.length;
  let i = 0;

  // After `>`/`>>`: allow only `&1`/`&2` (fd duplication) or a literal /dev/null target.
  const redirectTarget = (from) => {
    let j = from;
    if (command[j] === "&" && /[12]/.test(command[j + 1] ?? "") && !/[\w-]/.test(command[j + 2] ?? " ")) return j + 2;
    while (command[j] === " " || command[j] === "\t") j++;
    if (command.startsWith("/dev/null", j) && /^[\s;&|]?$/.test(command[j + 9] ?? "")) return j + 9;
    return -1;
  };

  while (i < n) {
    const c = command[i];
    if (c === "'") {
      const j = command.indexOf("'", i + 1);
      if (j < 0) return fail("unterminated quote");
      cur += command.slice(i + 1, j); started = true; i = j + 1; continue;
    }
    if (c === '"') {
      started = true; i++;
      for (;;) {
        if (i >= n) return fail("unterminated quote");
        const d = command[i];
        if (d === '"') { i++; break; }
        if (d === "\\") { if (i + 1 >= n) return fail("trailing backslash"); cur += command[i + 1]; i += 2; continue; }
        if (d === "$" || d === "`") return fail("variable or command substitution");
        cur += d; i++;
      }
      continue;
    }
    if (c === "\\") {
      if (i + 1 >= n) return fail("trailing backslash");
      if (command[i + 1] === "\n") { i += 2; continue; }
      cur += command[i + 1]; started = true; i += 2; continue;
    }
    if (c === "$" || c === "`") return fail("variable or command substitution");
    if (c === "(" || c === ")") return fail("subshell or grouping");
    if (c === "{" || c === "}") return fail("brace expansion or grouping (it can build a forbidden flag out of an allowed word)");
    if (c === "<") return fail("input redirection, here-document or process substitution");
    if (c === ">" || (c === "&" && command[i + 1] === ">")) {
      if (c === "&") i++; // `&>`
      else if (started && /^[0-9]$/.test(cur)) { cur = ""; started = false; } // `2>`: the digit was the fd, not a word
      else endWord();
      let j = i + 1;
      if (command[j] === ">") j++;
      const end = redirectTarget(j);
      if (end < 0) return fail("redirection to a file");
      i = end; continue;
    }
    if (c === ";" || c === "&" || c === "|" || c === "\n") { endSegment(); i++; continue; }
    if (c === " " || c === "\t" || c === "\r") { endWord(); i++; continue; }
    if (c === "#" && !started) { while (i < n && command[i] !== "\n") i++; continue; }
    cur += c; started = true; i++;
  }
  endSegment();
  return { ok: true, segments };
}

/* ------------------------------------------------------------------------------------------- command tables */

const has = (args, ...names) => args.some((a) => names.some((n) => a === n || a.startsWith(n + "=")));
// GNU getopt_long and git's option parser accept any unambiguous PREFIX of a long option (`sort --outp=f` writes
// a file; `git ls-remote --upload=cmd` runs one). So a long option is matched when the argument is a prefix of it.
const hasLong = (args, ...longs) => args.some((a) => {
  if (!a.startsWith("--") || a === "--") return false;
  const name = a.slice(2).split("=")[0];
  return longs.some((l) => l.slice(2).startsWith(name));
});
const cluster = (args, letter) => args.some((a) => /^-[^-]/.test(a) && a.includes(letter));

// Programs that are read-only for every argument except the flagged ones.
const SIMPLE = {
  ls: () => null, pwd: () => null, cat: () => null, head: () => null, tail: () => null, wc: () => null,
  grep: () => null, diff: () => null, cmp: () => null, stat: () => null, du: () => null, df: () => null,
  echo: () => null, printf: () => null, basename: () => null, dirname: () => null, realpath: () => null,
  readlink: () => null, which: () => null, uname: () => null, whoami: () => null, id: () => null,
  cut: () => null, tr: () => null, nl: () => null, tac: () => null, rev: () => null, column: () => null,
  paste: () => null, jq: () => null, sha256sum: () => null, md5sum: () => null, od: () => null,
  strings: () => null, true: () => null, false: () => null, test: () => null, "[": () => null, cd: () => null,
  date: (a) => (hasLong(a, "--set") || cluster(a, "s") ? "date -s sets the clock" : null),
  file: (a) => (hasLong(a, "--compile") || cluster(a, "C") ? "file -C writes a database" : null),
  tree: (a) => (cluster(a, "o") ? "tree -o writes a file" : null),
  sort: (a) => (cluster(a, "o") || hasLong(a, "--output", "--compress-program") ? "sort can write files or run a program" : null),
  rg: (a) => (hasLong(a, "--pre", "--pre-glob", "--hostname-bin", "--search-zip") || cluster(a, "z") ? "rg can run external programs" : null),
  find: (a) => (has(a, "-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprint", "-fprint0", "-fprintf", "-fls")
    ? "find can run programs or write files" : null),
};

const DELIVERY_CLIS = new Set(["scaffold", "executor", "review-cli", "conductor"]);

const GIT_READ = new Set(["status", "diff", "log", "show", "rev-parse", "rev-list", "ls-files", "ls-tree", "cat-file",
  "blame", "shortlog", "describe", "name-rev", "merge-base", "for-each-ref", "show-ref", "grep", "diff-tree",
  "diff-index", "diff-files", "whatchanged", "count-objects", "check-ignore", "ls-remote", "var", "verify-commit"]);
const GIT_GLOBAL_OK = new Set(["--no-pager", "-P", "--no-optional-locks"]);
const PROTECTED = /(^|[:/])(main|master)$/;

function gitVerdict(args) {
  let i = 0;
  while (i < args.length && args[i].startsWith("-")) {
    if (args[i] === "-C" && i + 1 < args.length) { i += 2; continue; }
    if (!GIT_GLOBAL_OK.has(args[i])) return deny(`git option ${args[i]} before the subcommand can run programs or change config`);
    i++;
  }
  const sub = args[i];
  const rest = args.slice(i + 1);
  if (!sub) return PASS;
  if (hasLong(rest, "--upload-pack", "--receive-pack", "--exec") || rest.some((a) => /^ext::/i.test(a)))
    return deny("git transport options and ext:: remotes can run arbitrary programs");

  if (GIT_READ.has(sub)) {
    if (hasLong(rest, "--output", "--ext-diff", "--open-files-in-pager") || rest.some((a) => /^-O/.test(a)))
      return deny(`git ${sub} option can write a file or run a program`);
    return PASS;
  }
  const positional = rest.filter((a) => !a.startsWith("-"));
  switch (sub) {
    case "branch": {
      const listing = has(rest, "--list", "--contains", "--merged", "--no-merged", "--no-contains");
      const safeFlags = new Set(["-a", "--all", "-r", "--remotes", "-v", "-vv", "--verbose", "--list", "--show-current",
        "--merged", "--no-merged", "--contains", "--no-contains", "--no-color", "--color"]);
      if (rest.some((a) => a.startsWith("-") && !safeFlags.has(a))) return deny("git branch with that option changes or deletes branches");
      if (positional.length && !listing) return ask("git branch <name> creates a branch. Publishing is allowed only when the user explicitly asked for it.");
      return PASS;
    }
    case "tag":
      if (positional.length && !has(rest, "-l", "--list")) return deny("git tag <name> creates a tag; not part of the delivery workflow");
      return rest.some((a) => a.startsWith("-") && !["-l", "--list", "-n"].includes(a)) ? deny("git tag option changes tags") : PASS;
    case "remote":
      return !rest.length || has(rest, "-v", "--verbose") || ["show", "get-url"].includes(rest[0]) ? PASS : deny("git remote can change remotes");
    case "config":
      return has(rest, "--get", "--get-all", "--get-regexp", "--list", "-l") && !hasLong(rest, "--unset", "--unset-all", "--add", "--replace-all", "--edit", "--remove-section", "--rename-section") && !has(rest, "-e")
        ? PASS : deny("git config may only read values");
    case "stash":
      return ["list", "show"].includes(rest[0]) ? PASS : deny("git stash is prohibited (it hides work from the ledger's source checks)");
    case "worktree":
      return rest[0] === "list" ? PASS : deny("git worktree may only be listed");
    case "reflog":
      return !rest.length || rest[0] === "show" ? PASS : deny("git reflog may only be read");
    case "add":
      return ask("git add stages changes. Allowed only when the user explicitly asked to publish; never during an active implementation loop.");
    case "commit":
      return ask("git commit creates a commit. Allowed only when the user explicitly asked to publish; never during an active implementation loop (delivery checkpoints are made by execute_and_review).");
    case "fetch":
      return ask("git fetch updates remote-tracking refs.");
    case "restore":
      return has(rest, "--staged") && !hasLong(rest, "--worktree") && !has(rest, "-W") ? ask("git restore --staged unstages selected changes.") : deny("git restore discards working-tree changes");
    case "checkout":
    case "switch":
      return (has(rest, "-b", "-B", "-c", "-C") || hasLong(rest, "--create", "--force-create")) && !has(rest, "--", "-f") && !hasLong(rest, "--force")
        ? ask(`git ${sub} -b creates a feature branch. Never change HEAD during an active implementation loop.`)
        : deny(`git ${sub} changes HEAD or the working tree`);
    case "push": {
      if (hasLong(rest, "--delete", "--mirror", "--prune", "--all") || has(rest, "-d") || positional.some((p) => p.startsWith(":") || p.startsWith("+")))
        return deny("git push that deletes or force-updates refs, or pushes every branch (--all), is not allowed");
      if (hasLong(rest, "--force") || has(rest, "-f") || cluster(rest, "f")) return deny("force-pushing is not allowed");
      if (positional.some((p) => PROTECTED.test(p))) return deny("pushing to a protected branch (main/master) is not allowed");
      const lease = rest.some((a) => a.startsWith("--force-with-lease"));
      return ask(lease
        ? "git push --force-with-lease rewrites remote history. Needs the user's separate, explicit confirmation; never on a protected branch."
        : "git push publishes a branch. Allowed only for a feature branch the user explicitly asked to publish; never main/master.");
    }
    case "merge": case "pull": case "rebase": case "cherry-pick": case "revert": case "am": case "apply":
      return deny(`git ${sub} changes HEAD; merging and history changes are human-controlled`);
    case "reset": case "clean":
      return deny(`git ${sub} discards work; prohibited by the delivery rules`);
    default:
      return deny(`git ${sub} is not on the read-only list`);
  }
}

const GH_READ = new Set(["pr:view", "pr:list", "pr:diff", "pr:checks", "pr:status", "issue:view", "issue:list", "issue:status",
  "repo:view", "run:view", "run:list", "workflow:view", "workflow:list", "release:view", "release:list", "auth:status",
  "search:code", "search:issues", "search:prs", "search:repos", "search:commits", "status:"]);

function ghVerdict(args) {
  const [area, action] = args;
  if (area === "pr" && action === "merge" || has(args, "--auto", "--admin")) return deny("merging is human-controlled; the agent must never merge PRs or enable auto-merge");
  if (area === "api") {
    const rest = args.slice(1);
    if (has(rest, "--method", "--field", "--raw-field", "--input") || rest.some((a) => /^-[^-]*[XfF]/.test(a)) || rest.includes("graphql"))
      return deny("gh api may only issue plain GET requests here (no method, fields, input or graphql)");
    return PASS;
  }
  if (GH_READ.has(`${area}:${area === "status" ? "" : action}`)) return PASS;
  if (area === "pr" && (action === "create" || action === "edit"))
    return ask(`gh pr ${action} publishes a PR. Allowed only when the user explicitly asked for it.`);
  return deny(`gh ${args.slice(0, 2).join(" ")} is not on the read-only list`);
}

function segmentVerdict(words) {
  const [name, ...args] = words;
  if (args.some((a) => a.startsWith("-") && /[*?[]/.test(a)))
    return deny("a flag containing a glob character can expand to a forbidden flag; spell flags out");
  if (/[\\/]/.test(name)) return deny(`${name}: run commands by bare name; paths are not allowed`);
  if (name.includes("=")) return deny("environment assignments before a command can change what it runs");
  if (DELIVERY_CLIS.has(name))
    return deny(`Do not run ${name} directly: it bypasses the delivery tools' authorization and evidence. Use the matching delivery tool.`);
  if (name === "git") return gitVerdict(args);
  if (name === "gh") return ghVerdict(args);
  const simple = Object.hasOwn(SIMPLE, name) ? SIMPLE[name] : null;
  if (simple) {
    const problem = simple(args);
    return problem ? deny(problem) : PASS;
  }
  return deny(`${name} is not on the read-only command list for delivery repositories`);
}

function combine(verdicts) {
  const denied = verdicts.find((v) => v.decision === "deny");
  if (denied) return denied;
  const asked = verdicts.filter((v) => v.decision === "ask");
  return asked.length ? ask([...new Set(asked.map((v) => v.reason))].join(" ")) : PASS;
}

/** Policy for a POSIX shell command string (Bash). */
export function posixShellVerdict(command) {
  if (typeof command !== "string" || !command.trim()) return deny("empty or unreadable command");
  const parsed = tokenize(command);
  if (!parsed.ok) return deny(`Command refused (${parsed.reason}). ${GUARD_HINT}`);
  const verdict = combine(parsed.segments.map(segmentVerdict));
  return verdict.decision === "deny" ? deny(`${verdict.reason} ${GUARD_HINT}`) : verdict;
}

/* ---------------------------------------------------------------------------------------------- PowerShell */

const PS_READ_CMDLETS = new Set(["get-childitem", "get-content", "select-string", "get-location", "test-path", "get-item",
  "resolve-path", "ls", "dir", "gci", "cat", "gc", "type", "pwd", "gl", "sls"]);

/**
 * PowerShell syntax (aliases, subexpressions, script blocks, backtick escapes, many redirections) cannot be
 * classified reliably, so only the simplest forms pass: one `git`/`gh` invocation, or one read cmdlet with
 * plain arguments. Everything else is refused.
 */
export function powershellVerdict(command) {
  if (typeof command !== "string" || !command.trim()) return deny("empty or unreadable command");
  const text = command.trim();
  const refuse = () => deny(`PowerShell is restricted to single read-only git/gh commands and Get-* cmdlets with plain arguments. ${GUARD_HINT}`);
  if (/[;|&<>$(){}`@\r\n]|''|""/.test(text)) return refuse();
  const parsed = tokenize(text);
  if (!parsed.ok || parsed.segments.length !== 1) return refuse();
  const [name, ...args] = parsed.segments[0];
  const lower = name.toLowerCase();
  if (lower === "git" || lower === "gh") {
    const v = segmentVerdict([lower, ...args]);
    return v.decision === "deny" ? deny(`${v.reason} ${GUARD_HINT}`) : v;
  }
  if (PS_READ_CMDLETS.has(lower) && args.every((a) => /^[\w.\-:\\/*?~=, ]*$/.test(a))) return PASS;
  return refuse();
}

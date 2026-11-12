import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { canonicalPath, decide, deliveryRoot, guardActive, guardMode, posixShellVerdict, powershellVerdict, tokenize } from "../pi/agent/lib/guard/index.mjs";
import { piGuardVerdict, resolvePiPath } from "../pi/agent/lib/guard/pi.mjs";
import { createToolCallGuard } from "../pi/agent/lib/host/pi.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Each row is the verdict a SECURE policy must give: "pass" (no opinion), "ask" (a human confirms) or "deny".
const POSIX = [
  // --- read-only inspection passes
  ["git status", "pass"], ["git status --porcelain=v2", "pass"], ["git diff HEAD~1 --stat", "pass"],
  ["git log --oneline -5 | head", "pass"], ["git --no-pager log -p -S foo", "pass"], ["git show HEAD:README.md", "pass"],
  ["git -C other status", "pass"], ["git log --format='%h %s'", "pass"], ["git diff --no-index a b", "pass"],
  ["git branch", "pass"], ["git branch -a", "pass"], ["git branch -vv", "pass"], ["git branch --list 'feature/*'", "pass"],
  ["git branch --contains abc123", "pass"], ["git tag", "pass"], ["git tag -l", "pass"],
  ["git remote -v", "pass"], ["git remote show origin", "pass"], ["git config --get user.name", "pass"], ["git config --list", "pass"],
  ["git stash list", "pass"], ["git stash show -p", "pass"], ["git worktree list", "pass"], ["git reflog", "pass"], ["git rev-parse --show-toplevel", "pass"],
  ["ls -la", "pass"], ["ls", "pass"], ["cat package.json | jq .name", "pass"], ['grep -rn "foo" src', "pass"],
  ["rg -n x --glob '*.ts'", "pass"], ["cd pi && ls", "pass"], ["find . -name '*.mjs' -type f", "pass"], ["wc -l *.mjs", "pass"],
  ["test -f x && echo yes || echo no", "pass"], ["[ -f x ]", "pass"], ["sort -u f", "pass"], ["sort -T /tmp f", "pass"], ["tail -n 20 log", "pass"],
  ["echo 'a;b'", "pass"], ['echo "a|b"', "pass"], ["echo '$(rm x)'", "pass"], ["ls '>' file", "pass"], ["ls # comment ; rm x", "pass"],
  ["git status 2>&1", "pass"], ["git log > /dev/null", "pass"], ["ls 2>/dev/null", "pass"], ["ls &>/dev/null", "pass"], ["ls >> /dev/null", "pass"], ["ls >&2", "pass"],
  ["gh pr view 12", "pass"], ["gh pr list --state open", "pass"], ["gh api repos/o/r/pulls/1/comments", "pass"], ["gh run view 1 --log", "pass"], ["gh status", "pass"],
  ["date", "pass"], ["diff a b", "pass"], ["printf '%s' x", "pass"],

  // --- publishing writes ask a human
  ["git add -A", "ask"], ["git commit -m 'msg'", "ask"], ["git add . && git commit -m x", "ask"], ["git push origin feature/x", "ask"],
  ["git push -u origin feature/x", "ask"], ["git push", "ask"], ["git checkout -b feature/y", "ask"], ["git switch -c feature/y", "ask"],
  ["git branch newfeature", "ask"], ["git fetch origin", "ask"], ["git restore --staged f", "ask"], ["git push --force-with-lease origin feature/x", "ask"],
  ["gh pr create --title x", "ask"], ["gh pr edit 1 --title x", "ask"],

  // --- writes, forbidden git/gh, delivery CLIs and merges are denied
  ["rm -rf x", "deny"], ["cp a b", "deny"], ["mv a b", "deny"], ["mkdir x", "deny"], ["touch x", "deny"], ["curl http://x", "deny"], ["wget http://x", "deny"],
  ["sed -i s/a/b/ f", "deny"], ["sed -n 1p f", "deny"], ["awk '{print}' f", "deny"], ["python -c 'print(1)'", "deny"], ["node -e 1", "deny"],
  ["npm test", "deny"], ["cargo build", "deny"], ["make", "deny"], ["./script.sh", "deny"], ["/bin/rm x", "deny"], ["bash -c 'rm x'", "deny"],
  ["sh -c ls", "deny"], ["eval ls", "deny"], ["exec ls", "deny"], ["env rm x", "deny"], ["sudo ls", "deny"], ["time ls", "deny"], ["nohup ls", "deny"],
  ["xargs rm", "deny"], ["ls | xargs rm", "deny"], ["timeout 5 ls", "deny"], ["command ls", "deny"], ["watch ls", "deny"], ["tee out", "deny"],
  ["scaffold summary --feature X", "deny"], ["executor run", "deny"], ["review-cli --help", "deny"], ["conductor run", "deny"],
  ["git reset --hard", "deny"], ["git reset HEAD f", "deny"], ["git stash", "deny"], ["git stash pop", "deny"], ["git stash drop", "deny"], ["git stash push", "deny"],
  ["git merge x", "deny"], ["git pull", "deny"], ["git rebase main", "deny"], ["git cherry-pick abc", "deny"], ["git revert abc", "deny"], ["git am p", "deny"],
  ["git apply p", "deny"], ["git clean -fd", "deny"], ["git gc", "deny"], ["git update-ref -d x", "deny"], ["git filter-branch", "deny"], ["git clone x", "deny"],
  ["git checkout main", "deny"], ["git checkout -- f", "deny"], ["git switch main", "deny"], ["git checkout -b x -f", "deny"], ["git restore f", "deny"],
  ["git restore --staged --worktree f", "deny"], ["git branch -D x", "deny"], ["git branch -d x", "deny"], ["git branch -m a b", "deny"], ["git branch -f x", "deny"],
  ["git tag v1", "deny"], ["git tag -d v1", "deny"], ["git remote add x y", "deny"], ["git remote set-url o u", "deny"], ["git config user.name x", "deny"],
  ["git config --global user.name x", "deny"], ["git config --get x --unset", "deny"], ["git worktree add p", "deny"], ["git reflog expire --all", "deny"],
  ["git push origin main", "deny"], ["git push origin master", "deny"], ["git push origin HEAD:main", "deny"], ["git push origin f:refs/heads/main", "deny"],
  ["git push -f origin x", "deny"], ["git push --force origin x", "deny"], ["git push -fu origin x", "deny"], ["git push origin +x", "deny"], ["git push origin :x", "deny"],
  ["git push --delete origin x", "deny"], ["git push --all", "deny"], ["git push --mirror", "deny"],
  ["git -c core.fsmonitor=evil status", "deny"], ["git --git-dir=x status", "deny"], ["git --exec-path=x status", "deny"],
  ["git diff --output=out.txt", "deny"], ["git log --output out", "deny"], ["git show --ext-diff", "deny"], ["git grep -Ofoo x", "deny"],
  ["gh pr merge 1", "deny"], ["gh pr merge --auto", "deny"], ["gh pr merge 1 --admin", "deny"], ["gh pr close 1", "deny"], ["gh pr comment 1 -b x", "deny"],
  ["gh issue create", "deny"], ["gh workflow run x", "deny"], ["gh api -X POST repos/o/r/issues", "deny"], ["gh api repos/o/r --method DELETE", "deny"],
  ["gh api graphql -f query=x", "deny"], ["gh api repos/o/r/issues -f title=x", "deny"], ["gh release create v1", "deny"], ["gh repo delete x", "deny"],
  ["find . -delete", "deny"], ["find . -exec rm {} \;", "deny"], ["find . -ok rm {} ;", "deny"], ["find . -fprint out", "deny"], ['find . "-exec" rm {} +', "deny"],
  ["sort -o out in", "deny"], ["sort -ro out in", "deny"], ["sort --output=out in", "deny"], ["rg --pre cmd x", "deny"], ["rg --pre=cmd x", "deny"], ["rg -z x", "deny"],
  ["date -s '2020-01-01'", "deny"], ["file -C", "deny"], ["tree -o out", "deny"],

  // --- syntax that hides or performs writes is denied outright
  ["echo hi > file", "deny"], ["echo hi >> file", "deny"], ["echo x>file", "deny"], ["cat file>out", "deny"], ["echo x >|file", "deny"], ["echo x 3>file", "deny"],
  ["echo x >(cat)", "deny"], ["ls > /dev/nullx", "deny"], ["ls >/dev/null/x", "deny"], ["ls <(cat x)", "deny"], ["cat <<EOF", "deny"], ["cat <<< x", "deny"], ["wc -l < f", "deny"],
  ["echo $(rm x)", "deny"], ['echo "$(rm x)"', "deny"], ["echo `rm x`", "deny"], ['echo "`rm x`"', "deny"], ["ls $HOME", "deny"], ["echo $'a'", "deny"], ["echo ${x}", "deny"],
  ["(cd x && rm y)", "deny"], ["{ rm x; }", "deny"], ["ls; rm x", "deny"], ["ls;rm x", "deny"], ["ls && rm x", "deny"], ["ls&&rm x", "deny"], ["ls || rm x", "deny"],
  ["ls | rm x", "deny"], ["ls\nrm x", "deny"], ["ls &\nrm x", "deny"], ["ls #x\nrm y", "deny"], ["git status; git push --force", "deny"], ["ls >/dev/null; rm x", "deny"],
  ["FOO=1 git status", "deny"], ["GIT_EXTERNAL_DIFF=evil git diff", "deny"], ["for f in *; do rm $f; done", "deny"], ["if true; then rm x; fi", "deny"], ["! rm x", "deny"],
  // found by attacking the first version of the policy: each of these used to pass
  ["find . -{exec,name} rm {} +", "deny"], ["find . -{delete,name}", "deny"], ["sort -{o,u} out in", "deny"], ["echo a{1,2}", "deny"],
  ["find . -exe? rm {} +", "deny"], ["find . -ex* rm {} +", "deny"], ["ls -[a]", "deny"],
  ["gh api -XPOST repos/o/r/issues", "deny"], ["gh api -XDELETE repos/o/r", "deny"], ["gh api repos/o/r/issues -fTitle=x", "deny"],
  ["gh api repos/o/r -Fa=@file", "deny"], ["gh api -ipf k=v repos/o/r", "deny"], ["gh api -i repos/o/r", "pass"], ["gh api repos/o/r -q .name", "pass"],
  ["rg -nz foo", "deny"], ["rg -n foo", "pass"], ["tree -ao out", "deny"], ["tree -a", "pass"], ["file -bC", "deny"], ["file -b x", "pass"],
  ["git ls-remote --upload-pack=evil .", "deny"], ["git fetch --upload-pack=evil .", "deny"], ["git push --receive-pack=evil o f", "deny"],
  ["git ls-remote ext::sh", "deny"], ["git fetch ext::sh", "deny"], ["git ls-remote origin", "pass"],
  // long options may be abbreviated to any unambiguous prefix (verified on this machine: `sort --outp=f` writes a file)
  ["sort --outp=out in", "deny"], ["sort --out=out in", "deny"], ["sort --o=out in", "deny"], ["sort --comp=cmd in", "deny"],
  ["date --se=x", "deny"], ["date --s=x", "deny"], ["file --comp", "deny"], ["rg --pr=cmd x", "deny"], ["rg --pre-g x", "deny"],
  ["git ls-remote --upload=cmd .", "deny"], ["git ls-remote --up=cmd .", "deny"], ["git fetch --receive=cmd .", "deny"], ["git ls-remote --ex=cmd .", "deny"],
  ["git log --outp=x", "deny"], ["git diff --ext=x", "deny"], ["git grep --open-f=x y", "deny"],
  ["git push --fo origin f", "deny"], ["git push --forc origin f", "deny"], ["git push --del origin f", "deny"], ["git push --mir", "deny"], ["git push --al", "deny"],
  ["git restore --staged --work f", "deny"], ["git checkout --crea x", "ask"], ["git config --get --unset-a k", "deny"], ["git config --get --remove-sec x", "deny"],
  ["sort --reverse f", "pass"], ["sort --unique f", "pass"], ["sort --ra f", "pass"], ["date --iso-8601", "pass"], ["rg --pretty foo", "pass"], ["rg --smart-case foo", "pass"],
  ["git log --oneline", "pass"], ["git diff --stat", "pass"], ["git diff --no-ext-diff", "pass"], ["git log --graph --decorate", "pass"], ["git push --force-with-lease origin f", "ask"],
  ["ls 'unterminated", "deny"], ['ls "unterminated', "deny"], ["ls \\", "deny"], ["", "deny"], ["   ", "deny"],
];

test("POSIX shell policy: every row gets the secure verdict", () => {
  const wrong = POSIX.filter(([command, want]) => posixShellVerdict(command).decision !== want)
    .map(([command, want]) => `${JSON.stringify(command)}: wanted ${want}, got ${posixShellVerdict(command).decision}`);
  assert.deepEqual(wrong, []);
  assert.ok(POSIX.length > 220, "keep the table broad");
});

test("verdicts carry a reason that tells the agent what to do instead", () => {
  assert.match(posixShellVerdict("rm x").reason, /execute_and_review/);
  assert.match(posixShellVerdict("scaffold summary").reason, /bypasses the delivery tools/);
  assert.match(posixShellVerdict("gh pr merge 1").reason, /human-controlled/);
  assert.match(posixShellVerdict("git push origin main").reason, /protected branch/);
  assert.match(posixShellVerdict("git commit -m x").reason, /never during an active implementation loop/);
  assert.match(posixShellVerdict("git commit -m x && git push origin f").reason, /publishes a branch/, "ask reasons are combined");
  assert.equal(posixShellVerdict(42).decision, "deny");
  assert.equal(posixShellVerdict(undefined).decision, "deny");
});

test("one denied segment denies the whole command, even next to an ask", () => {
  assert.equal(posixShellVerdict("git add . && rm x").decision, "deny");
  assert.equal(posixShellVerdict("git add . && git push origin main").decision, "deny");
});

test("tokenizer: quotes are data, operators split, only /dev/null redirects survive", () => {
  assert.deepEqual(tokenize("echo 'a;b' \"c|d\" e").segments, [["echo", "a;b", "c|d", "e"]]);
  assert.deepEqual(tokenize("a && b | c; d").segments, [["a"], ["b"], ["c"], ["d"]]);
  assert.deepEqual(tokenize("ls 2>&1").segments, [["ls"]], "the fd digit is not an argument");
  assert.deepEqual(tokenize("ls 2>/dev/null | wc").segments, [["ls"], ["wc"]]);
  assert.deepEqual(tokenize("find . \"-exec\" x").segments, [["find", ".", "-exec", "x"]], "quote removal exposes the real flag");
  assert.equal(tokenize("echo $x").ok, false);
  assert.equal(tokenize("echo > f").ok, false);
});

const PS = [
  ["git status", "pass"], ["git log --format=\"%h %s\"", "pass"], ["git diff --stat", "pass"], ["gh pr view 1", "pass"],
  ["Get-ChildItem -Recurse src", "pass"], ["ls", "pass"], ["dir src", "pass"], ["Get-Content package.json", "pass"], ["cat package.json", "pass"], ["Select-String -Pattern x -Path y", "pass"],
  ["Get-Location", "pass"], ["Test-Path x", "pass"], ["Get-Content -Path 'a b'", "pass"],
  ["git add .", "ask"], ["git commit -m x", "ask"], ["gh pr create", "ask"],
  ["git push --force", "deny"], ["git push origin main", "deny"], ["git reset --hard", "deny"], ["gh pr merge 1", "deny"],
  ["Remove-Item x", "deny"], ["rm x", "deny"], ["Set-Content x y", "deny"], ["Out-File x", "deny"], ["New-Item x", "deny"], ["Copy-Item a b", "deny"],
  ["Invoke-Expression ls", "deny"], ["iex ls", "deny"], ["Invoke-WebRequest http://x", "deny"], ["Start-Process x", "deny"], ["node -e 1", "deny"], ["npm test", "deny"],
  ["git status; rm x", "deny"], ["git status | Out-File x", "deny"], ["Get-Content x | Set-Content y", "deny"], ["& git status", "deny"], ["git status > out", "deny"],
  ["Get-Content (Get-Item x)", "deny"], ["Get-Content $env:TEMP", "deny"], ["Get-Content `x", "deny"], ["ls @(1)", "deny"], ["git status && git push", "deny"],
  ["Get-Content 'it''s'", "deny"], ["git log \"\"x\"\"", "deny"], ["Get-Content ./x.ps1 ; calc", "deny"], ["", "deny"], ["scaffold summary", "deny"],
];

test("PowerShell policy: only a single read-only git/gh command or plain Get-* cmdlet passes", () => {
  const wrong = PS.filter(([command, want]) => powershellVerdict(command).decision !== want)
    .map(([command, want]) => `${JSON.stringify(command)}: wanted ${want}, got ${powershellVerdict(command).decision}`);
  assert.deepEqual(wrong, []);
});

/* ------------------------------------------------------------------------------------ activation & routing */

function repo(t, { feature = true, git = true } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-guard-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  if (git) mkdirSync(path.join(dir, ".git"));
  if (feature) mkdirSync(path.join(dir, ".scaffold", "features", "F-1.abc"), { recursive: true });
  mkdirSync(path.join(dir, "src"), { recursive: true });
  return dir;
}

const call = (tool_name, tool_input, cwd, env = {}) => decide({ tool_name, tool_input, cwd }, { env });

test("file tools are denied where a delivery is active, from the root or any subdirectory", (t) => {
  const dir = repo(t);
  for (const tool of ["Edit", "Write", "NotebookEdit", "MultiEdit"]) {
    for (const cwd of [dir, path.join(dir, "src")]) {
      const v = call(tool, { file_path: path.join(dir, "src", "a.mjs"), notebook_path: path.join(dir, "n.ipynb") }, cwd);
      assert.equal(v.decision, "deny", `${tool} from ${cwd}`);
      assert.match(v.reason, /execute_and_review/);
    }
  }
});

test("ordinary repositories and empty feature directories are untouched", (t) => {
  const plain = repo(t, { feature: false });
  assert.equal(call("Edit", { file_path: path.join(plain, "a") }, plain).decision, "pass");
  assert.equal(call("Bash", { command: "rm -rf x" }, plain).decision, "pass");
  const empty = repo(t, { feature: false });
  mkdirSync(path.join(empty, ".scaffold", "features"), { recursive: true });
  assert.equal(call("Write", { file_path: path.join(empty, "a") }, empty).decision, "pass");
  assert.equal(call("Write", { file_path: "/x" }, path.join(tmpdir(), "no-such-dir-xyz")).decision, "pass", "unreadable tree means no delivery");
});

test("the walk stops at the nearest repository root, so a nested repository is judged on its own", (t) => {
  const outer = repo(t);
  const inner = path.join(outer, "vendor", "lib");
  mkdirSync(path.join(inner, ".git"), { recursive: true });
  assert.equal(deliveryRoot(inner), null);
  assert.equal(deliveryRoot(path.join(outer, "src")), outer);
  assert.equal(call("Edit", { file_path: path.join(inner, "a") }, inner).decision, "pass");
});

test("a file tool aimed at an active delivery elsewhere is denied even when cwd is not in it", (t) => {
  const active = repo(t);
  const elsewhere = repo(t, { feature: false });
  assert.equal(call("Edit", { file_path: path.join(active, "src", "a.mjs") }, elsewhere).decision, "deny");
  assert.equal(call("NotebookEdit", { notebook_path: path.join(active, "n.ipynb") }, elsewhere).decision, "deny");
  assert.equal(call("Edit", { file_path: path.join(elsewhere, "a") }, elsewhere).decision, "pass");
});

test("shell tools are routed: Bash and Monitor to the POSIX policy, PowerShell to its own", (t) => {
  const dir = repo(t);
  assert.equal(call("Bash", { command: "git status" }, dir).decision, "pass");
  assert.equal(call("Bash", { command: "rm x" }, dir).decision, "deny");
  assert.equal(call("Monitor", { command: "rm x" }, dir).decision, "deny");
  assert.equal(call("Bash", { command: "git add ." }, dir).decision, "ask");
  assert.equal(call("PowerShell", { command: "git status" }, dir).decision, "pass");
  assert.equal(call("PowerShell", { command: "Remove-Item x" }, dir).decision, "deny");
  assert.equal(call("Bash", {}, dir).decision, "deny", "a shell call with no command is refused, not waved through");
  assert.equal(call("Bash", { command: ["rm", "x"] }, dir).decision, "deny");
});

test("other tools are never touched", (t) => {
  const dir = repo(t);
  for (const tool of ["Read", "Grep", "Glob", "WebFetch", "Skill", "TodoWrite", "mcp__x__y", undefined]) {
    assert.equal(call(tool, { file_path: "/x", command: "rm x" }, dir).decision, "pass", String(tool));
  }
  assert.equal(decide(null).decision, "pass");
  assert.equal(decide({}).decision, "pass");
});

test("PI_DELIVERY_GUARD: only exactly off disables; on forces; anything else stays automatic", (t) => {
  const dir = repo(t);
  const plain = repo(t, { feature: false });
  assert.equal(guardMode({}), "auto");
  for (const [value, mode] of [["off", "off"], [" OFF ", "off"], ["on", "on"], ["ON", "on"], ["0", "auto"], ["false", "auto"], ["disabled", "auto"], ["", "auto"], ["offf", "auto"]]) {
    assert.equal(guardMode({ PI_DELIVERY_GUARD: value }), mode, JSON.stringify(value));
  }
  assert.equal(call("Edit", { file_path: "/x" }, dir, { PI_DELIVERY_GUARD: "off" }).decision, "pass");
  assert.equal(call("Edit", { file_path: "/x" }, dir, { PI_DELIVERY_GUARD: "0" }).decision, "deny", "a typo must not disable the guard");
  assert.equal(call("Edit", { file_path: "/x" }, plain, { PI_DELIVERY_GUARD: "on" }).decision, "deny");
});

test("cwd falls back to CLAUDE_PROJECT_DIR, then the process directory", (t) => {
  const dir = repo(t);
  assert.equal(decide({ tool_name: "Bash", tool_input: { command: "rm x" } }, { env: { CLAUDE_PROJECT_DIR: dir } }).decision, "deny");
});

/* ---------------------------------------------------------------------------------- the hook as Claude runs it */

const hook = (event, env = {}) => spawnSync(process.execPath, [path.join(root, "pi/claude/guard.mjs")], {
  input: typeof event === "string" ? event : JSON.stringify(event),
  encoding: "utf8", timeout: 30000, env: { ...process.env, PI_DELIVERY_GUARD: "", ...env },
});

test("hook contract: deny is exit 2 with the reason on stderr and nothing on stdout", (t) => {
  const dir = repo(t);
  const run = hook({ tool_name: "Edit", tool_input: { file_path: path.join(dir, "a") }, cwd: dir });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /execute_and_review/);
  assert.equal(run.stdout, "");
});

test("hook contract: ask is exit 0 with a PreToolUse ask decision", (t) => {
  const dir = repo(t);
  const run = hook({ tool_name: "Bash", tool_input: { command: "git commit -m x" }, cwd: dir });
  assert.equal(run.status, 0);
  const out = JSON.parse(run.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.equal(out.hookSpecificOutput.permissionDecision, "ask");
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /git commit/);
});

test("hook contract: pass is silent exit 0 (the guard never grants access)", (t) => {
  const dir = repo(t);
  for (const event of [{ tool_name: "Bash", tool_input: { command: "git status" }, cwd: dir }, { tool_name: "Read", tool_input: {}, cwd: dir }]) {
    const run = hook(event);
    assert.deepEqual([run.status, run.stdout, run.stderr], [0, "", ""]);
  }
});

test("hook contract: unreadable input blocks, and the user override works", (t) => {
  const dir = repo(t);
  for (const bad of ["", "not json", "{"]) assert.equal(hook(bad).status, 2, JSON.stringify(bad));
  const run = hook({ tool_name: "Edit", tool_input: { file_path: "/x" }, cwd: dir }, { PI_DELIVERY_GUARD: "off" });
  assert.equal(run.status, 0);
});

/* ------------------------------------------------------------------------------ the Claude Code plugin files */

import { readFileSync, existsSync } from "node:fs";
import { projectDirectory } from "../pi/agent/lib/host/mcp.mjs";
import { deliveryMcpServerConfig } from "../pi/agent/lib/host/pi.mjs";

const json = (file) => JSON.parse(readFileSync(path.join(root, file), "utf8"));
const inPlugin = (p) => path.join(root, "pi", p.replace("${CLAUDE_PLUGIN_ROOT}/", ""));

test("plugin manifest names the plugin and sits at the plugin root", () => {
  const manifest = json("pi/.claude-plugin/plugin.json");
  assert.equal(manifest.name, "pi-delivery");
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
});

test("the guard hook is registered so that it fails CLOSED and covers every way to change files", () => {
  const entries = json("pi/hooks/hooks.json").hooks.PreToolUse;
  assert.equal(entries.length, 1);
  const [{ matcher, hooks }] = entries;
  const matched = matcher.split("|");
  for (const tool of ["Edit", "Write", "NotebookEdit", "MultiEdit", "Bash", "PowerShell"]) {
    assert.ok(matched.includes(tool), `${tool} must be guarded`);
  }
  assert.equal(hooks.length, 1);
  const [hook] = hooks;
  assert.equal(hook.type, "command");
  // Claude Code lets a failing hook (crash, timeout, missing script) through by default. A guard must not.
  assert.equal(hook.onFailure, "block", "without onFailure=block a crashing guard silently allows everything");
  assert.ok(hook.timeout > 0 && hook.timeout <= 30);
  // Exec form: no shell, so paths with spaces or quotes cannot be mangled.
  assert.equal(hook.command, "node");
  assert.deepEqual(hook.args.length, 1);
  assert.ok(existsSync(inPlugin(hook.args[0])), `${hook.args[0]} must exist inside the plugin`);
});

test("the MCP entry launches the server from inside the plugin, so the plugin is self-contained", () => {
  const { mcpServers } = json("pi/.mcp.json");
  assert.deepEqual(Object.keys(mcpServers), ["pidelivery"]);
  const server = mcpServers.pidelivery;
  assert.equal(server.command, "node");
  for (const arg of server.args) {
    assert.ok(arg.startsWith("${CLAUDE_PLUGIN_ROOT}/"), "paths must be plugin-relative (a path that escapes the plugin root is rejected)");
    assert.ok(existsSync(inPlugin(arg)), `${arg} must exist`);
    assert.ok(!arg.includes(".."), "no parent-directory escapes");
  }
});

test("server project directory: Claude Code's CLAUDE_PROJECT_DIR wins, otherwise the process directory", () => {
  assert.equal(projectDirectory({ CLAUDE_PROJECT_DIR: "/proj" }, "/cwd"), "/proj");
  assert.equal(projectDirectory({}, "/cwd"), "/cwd");
  assert.equal(projectDirectory({ CLAUDE_PROJECT_DIR: "" }, "/cwd"), "/cwd", "empty counts as unset");
  assert.equal(deliveryMcpServerConfig("/x/start.mjs").env.CLAUDE_PROJECT_DIR, "", "Pi blanks it so a value inherited from a Claude Code shell cannot redirect Pi's server");
});

/* ------------------------------------------------------------------------------------------- Pi's tool_call */

const piCall = (toolName, input, cwd, env = {}) => piGuardVerdict({ toolName, input }, { cwd, env });

test("Pi: edit and write are blocked in an active delivery whichever way the path is spelled", (t) => {
  const dir = repo(t);
  for (const tool of ["edit", "write"]) {
    for (const p of [path.join(dir, "src", "a.mjs"), "src/a.mjs", "./src/a.mjs", "@src/a.mjs", "@" + path.join(dir, "src", "a.mjs"), "../" + path.basename(dir) + "/src/a.mjs"]) {
      const v = piCall(tool, { path: p, content: "x", edits: [] }, dir);
      assert.equal(v.decision, "deny", `${tool} ${p}`);
      assert.match(v.reason, /execute_and_review/);
    }
  }
  assert.equal(piCall("write", {}, dir).decision, "deny", "a call with no path is refused, not waved through");
  assert.equal(piCall("edit", { path: 42 }, dir).decision, "deny");
});

test("Pi: a relative path is resolved against the session directory, so another repo's delivery is caught", (t) => {
  const active = repo(t);
  const plain = repo(t, { feature: false });
  const rel = path.relative(plain, path.join(active, "src", "a.mjs"));
  assert.equal(piCall("write", { path: rel }, plain).decision, "deny", "writes into an active delivery from outside it");
  assert.equal(piCall("write", { path: "src/a.mjs" }, plain).decision, "pass", "the same spelling inside a plain repo is fine");
});

test("Pi: read-only built-ins and unknown tools are never touched", (t) => {
  const dir = repo(t);
  for (const tool of ["read", "grep", "find", "ls", "write_plan", "scaffold_tasks", "execute_and_review", "mcp__pidelivery__execute_and_review", "lsp", undefined]) {
    assert.equal(piCall(tool, { path: "x", command: "rm x" }, dir).decision, "pass", String(tool));
  }
  assert.equal(piGuardVerdict(undefined, { cwd: dir }).decision, "pass");
});

test("Pi: bash and powershell go through the shell policy", (t) => {
  const dir = repo(t);
  assert.equal(piCall("bash", { command: "git status" }, dir).decision, "pass");
  assert.equal(piCall("bash", { command: "rm -rf x" }, dir).decision, "deny");
  assert.equal(piCall("bash", { command: "git commit -m x" }, dir).decision, "ask");
  assert.equal(piCall("bash", { command: "echo hi > f" }, dir).decision, "deny");
  assert.equal(piCall("bash", { command: "scaffold clean --all" }, dir).decision, "deny");
  assert.equal(piCall("bash", {}, dir).decision, "deny");
  assert.equal(piCall("powershell", { command: "git status" }, dir).decision, "pass");
  assert.equal(piCall("powershell", { command: "Remove-Item x" }, dir).decision, "deny");
  assert.equal(piCall("bash", { command: "rm -rf x" }, repo(t, { feature: false })).decision, "pass", "no delivery, no guard");
});

test("Pi: write_ticket_file may only write .ticket-*.md while a delivery is active", (t) => {
  const dir = repo(t);
  for (const ok of [".ticket-adhoc-cache-fix.md", ".ticket-x.md", ".ticket-A_b-1.2.md"]) assert.equal(piCall("write_ticket_file", { filename: ok }, dir).decision, "pass", ok);
  for (const bad of ["README.md", "docs.md", ".ticket-.md", ".ticket-x.txt", "ticket-x.md", ".ticket-../x.md", ".ticket-x.md/../README.md", "", undefined]) {
    assert.equal(piCall("write_ticket_file", { filename: bad }, dir).decision, "deny", String(bad));
  }
  assert.equal(piCall("write_ticket_file", { filename: "README.md" }, repo(t, { feature: false })).decision, "pass", "unguarded elsewhere");
  assert.equal(piCall("write_ticket_file", { filename: "README.md" }, dir, { PI_DELIVERY_GUARD: "off" }).decision, "pass");
});

test("guardActive is what decide and the Pi adapter both use", (t) => {
  const dir = repo(t);
  const plain = repo(t, { feature: false });
  assert.equal(guardActive({ cwd: dir, env: {} }), true);
  assert.equal(guardActive({ cwd: plain, env: {} }), false);
  assert.equal(guardActive({ cwd: plain, target: path.join(dir, "x"), env: {} }), true);
  assert.equal(guardActive({ cwd: dir, env: { PI_DELIVERY_GUARD: "off" } }), false);
  assert.equal(guardActive({ cwd: plain, env: { PI_DELIVERY_GUARD: "on" } }), true);
});

const handle = (event, ctx, env = {}) => createToolCallGuard({ env })(event, ctx);

test("Pi handler: deny blocks with the reason, pass returns nothing", async (t) => {
  const dir = repo(t);
  const denied = await handle({ toolName: "write", input: { path: "a.txt", content: "x" } }, { cwd: dir, hasUI: true });
  assert.equal(denied.block, true);
  assert.match(denied.reason, /execute_and_review/);
  assert.equal("terminate" in denied, false, "do not end the agent loop: the model should read the reason and adapt");
  assert.equal(await handle({ toolName: "read", input: { path: "a" } }, { cwd: dir }), undefined);
  assert.equal(await handle({ toolName: "bash", input: { command: "git status" } }, { cwd: dir }), undefined);
});

test("Pi handler: ask is the user's decision, and every way of not getting a yes is a block", async (t) => {
  const dir = repo(t);
  const event = { toolName: "bash", input: { command: "git commit -m x" } };
  const asked = [];
  const ui = (answer) => ({ confirm: async (...a) => { asked.push(a); if (answer instanceof Error) throw answer; return answer; } });

  assert.equal(await handle(event, { cwd: dir, hasUI: true, ui: ui(true) }), undefined, "an explicit yes runs it");
  assert.match(asked[0][1], /git commit -m x/, "the prompt shows the command");
  assert.match(asked[0][1], /explicitly asked to publish/, "and why it needs a human");

  for (const answer of [false, undefined, null, "yes", 1, new Error("prompt crashed")]) {
    const result = await handle(event, { cwd: dir, hasUI: true, ui: ui(answer) });
    assert.equal(result?.block, true, `answer ${String(answer)}`);
  }
  const headless = await handle(event, { cwd: dir, hasUI: false, ui: ui(true) });
  assert.equal(headless.block, true);
  assert.match(headless.reason, /no user interface/);
  assert.equal((await handle(event, { cwd: dir, ui: ui(true) })).block, true, "hasUI must be exactly true");
});

test("Pi handler: an unexpected error blocks instead of letting the call through", async (t) => {
  const dir = repo(t);
  const broken = { toolName: "bash", get input() { throw new Error("boom"); } };
  const result = await handle(broken, { cwd: dir });
  assert.equal(result.block, true);
  assert.match(result.reason, /delivery guard failed \(boom\)/);
});

test("Pi handler: PI_DELIVERY_GUARD=off disables it, and a typo does not", async (t) => {
  const dir = repo(t);
  const event = { toolName: "write", input: { path: "a" } };
  assert.equal(await handle(event, { cwd: dir }, { PI_DELIVERY_GUARD: "off" }), undefined);
  assert.equal((await handle(event, { cwd: dir }, { PI_DELIVERY_GUARD: "0" })).block, true);
});

test("the Pi extension is just the handler, registered for tool_call", () => {
  const source = readFileSync(path.join(root, "pi/agent/extensions/delivery-guard/index.ts"), "utf8");
  assert.match(source, /pi\.on\("tool_call", createToolCallGuard\(\)\)/);
  assert.equal((source.match(/pi\.on\(/g) ?? []).length, 1, "one handler, nothing else");
  assert.doesNotMatch(source, /block: false|return undefined|setActiveTools/, "no logic here that could widen what the guard allows");
});

/* ---------------------------------------------- review findings on #103: aliases of a path, and links */

// Expected values are what Pi's own resolver (utils/paths.js resolvePath, with normalizeUnicodeSpaces and
// stripAtPrefix) returned for these inputs with HOME=/home/someone and cwd=/work/repo, captured from Pi 1.5.2.
// A spelling the guard reads differently from Pi is a bypass, so these must match exactly.
const HOME = "/home/someone", CWD = "/work/repo";
const PI_RESOLVES = [
  ["~", "/home/someone"], ["~/x", "/home/someone/x"], ["@~/x", "/home/someone/x"], ["~//x", "/home/someone/x"],
  ["~x", "/work/repo/~x"], ["~user/x", "/work/repo/~user/x"], ["@@x", "/work/repo/@x"], [" x", "/work/repo/ x"],
  ["a b/c", "/work/repo/a b/c"], ["file:///tmp/a%20b", "/tmp/a b"], ["@file:///tmp/a", "/tmp/a"],
  ["./x/../y", "/work/repo/y"], ["x/./y//z", "/work/repo/x/y/z"], ["/abs/x", "/abs/x"], ["x", "/work/repo/x"],
];

test("resolvePiPath matches Pi's own resolver for tilde, file:// URLs, Unicode spaces and @", () => {
  const wrong = PI_RESOLVES.filter(([input, want]) => resolvePiPath(input, CWD, { home: HOME, platform: "linux" }) !== want)
    .map(([input, want]) => `${JSON.stringify(input)}: wanted ${want}, got ${resolvePiPath(input, CWD, { home: HOME, platform: "linux" })}`);
  assert.deepEqual(wrong, []);
  assert.throws(() => resolvePiPath("file://some-host/share/x", CWD, { home: HOME, platform: "linux" }), "a non-local file URL throws, as in Pi");
});

test("Pi: every alias of a write into an active delivery is caught from OUTSIDE it", (t) => {
  const active = repo(t);                       // .../pi-guard-XXXX
  const plain = repo(t, { feature: false });
  const home = path.dirname(active);            // so "~/<name>/..." names the active repo
  const name = path.basename(active);
  const verdict = (p) => piGuardVerdict({ toolName: "write", input: { path: p, content: "x" } }, { cwd: plain, env: {}, home, platform: "linux" });
  for (const alias of [`~/${name}/src/a.txt`, `@~/${name}/src/a.txt`, `~//${name}/src/a.txt`, `file://${path.join(active, "src", "a.txt")}`,
    `@file://${path.join(active, "src", "a.txt")}`, path.join(active, "src", "a.txt"), path.relative(plain, path.join(active, "src", "a.txt"))]) {
    assert.equal(verdict(alias).decision, "deny", alias);
  }
  assert.equal(verdict("~/no-such-repo-here/a.txt").decision, "pass", "the same spelling into a place with no delivery is fine");
  assert.equal(verdict(`~/${path.basename(plain)}/a.txt`).decision, "pass");
});

test("Pi handler: a path Pi cannot resolve is blocked, not waved through", async (t) => {
  const dir = repo(t, { feature: false });
  const result = await createToolCallGuard({ env: {} })({ toolName: "write", input: { path: "file://remote-host/x" } }, { cwd: dir });
  assert.equal(result.block, true);
  assert.match(result.reason, /delivery guard failed/);
});

// Linux/macOS: creating symlinks needs privileges on Windows, so skip there instead of failing.
function link(t, fn) {
  try { fn(); } catch (error) { if (["EPERM", "EACCES", "ENOSYS"].includes(error.code)) { t.skip("cannot create links here"); return false; } throw error; }
  return true;
}

test("a symlinked directory or working directory cannot hide the delivery it leads into (both hosts)", (t) => {
  const active = repo(t);
  const plain = repo(t, { feature: false });
  if (!link(t, () => symlinkSync(path.join(active, "src"), path.join(plain, "alias")))) return;
  symlinkSync(active, path.join(plain, "whole"));
  const target = path.join(plain, "alias", "a.txt");
  assert.equal(decide({ tool_name: "Write", tool_input: { file_path: target }, cwd: plain }, { env: {} }).decision, "deny", "Claude Code: write through a directory link");
  assert.equal(piGuardVerdict({ toolName: "write", input: { path: "alias/a.txt" } }, { cwd: plain, env: {} }).decision, "deny", "Pi: same");
  assert.equal(piGuardVerdict({ toolName: "write", input: { path: "whole/src/a.txt" } }, { cwd: plain, env: {} }).decision, "deny");
  assert.equal(decide({ tool_name: "Bash", tool_input: { command: "rm x" }, cwd: path.join(plain, "whole") }, { env: {} }).decision, "deny", "the working directory itself reached through a link");
  assert.equal(deliveryRoot(path.join(plain, "whole", "src")), realpathSync(active));
  assert.equal(piGuardVerdict({ toolName: "write", input: { path: "plain-file.txt" } }, { cwd: plain, env: {} }).decision, "pass", "control: no link, no delivery");
});

test("a symlinked FILE, including a dangling one, is judged by where it really leads", (t) => {
  const active = repo(t);
  const plain = repo(t, { feature: false });
  writeFileSync(path.join(active, "src", "real.txt"), "x");
  if (!link(t, () => symlinkSync(path.join(active, "src", "real.txt"), path.join(plain, "file-link")))) return;
  symlinkSync(path.join(active, "src", "not-yet.txt"), path.join(plain, "dangling-link"));
  for (const name of ["file-link", "dangling-link"]) {
    assert.equal(piGuardVerdict({ toolName: "write", input: { path: name } }, { cwd: plain, env: {} }).decision, "deny", name);
    assert.equal(decide({ tool_name: "Edit", tool_input: { file_path: path.join(plain, name) }, cwd: plain }, { env: {} }).decision, "deny", name);
  }
});

test("canonicalPath follows links, keeps a missing remainder, and never throws", (t) => {
  const dir = repo(t, { feature: false });
  if (!link(t, () => symlinkSync(path.join(dir, "src"), path.join(dir, "l")))) return;
  const real = realpathSync(dir);
  assert.equal(canonicalPath(path.join(dir, "l", "missing", "x.txt")), path.join(real, "src", "missing", "x.txt"));
  assert.equal(canonicalPath(path.join(dir, "nope", "x")), path.join(real, "nope", "x"));
  symlinkSync("loop-b", path.join(dir, "loop-a")); symlinkSync("loop-a", path.join(dir, "loop-b"));
  assert.equal(typeof canonicalPath(path.join(dir, "loop-a")), "string", "a symlink loop does not hang or throw");
  assert.equal(typeof canonicalPath(""), "string");
});

test("planning tools may not write through a link while a delivery is active", (t) => {
  const dir = repo(t);
  writeFileSync(path.join(dir, "README.md"), "readme");
  const ticket = (filename) => piGuardVerdict({ toolName: "write_ticket_file", input: { filename } }, { cwd: dir, env: {} });
  const plan = () => piGuardVerdict({ toolName: "write_plan", input: { content: "x" } }, { cwd: dir, env: {} });

  assert.equal(ticket(".ticket-new.md").decision, "pass", "a name that does not exist yet");
  writeFileSync(path.join(dir, ".ticket-plain.md"), "old");
  assert.equal(ticket(".ticket-plain.md").decision, "pass", "overwriting an ordinary ticket file is the tool's purpose");
  assert.equal(plan().decision, "pass", "no .pi directory yet");

  if (!link(t, () => symlinkSync("README.md", path.join(dir, ".ticket-fix.md")))) return;
  const v = ticket(".ticket-fix.md");
  assert.equal(v.decision, "deny", "a name the filename rule accepts, but which is a symlink to README.md");
  assert.match(v.reason, /through a link/);
  symlinkSync("missing-target.md", path.join(dir, ".ticket-dangling.md"));
  assert.equal(ticket(".ticket-dangling.md").decision, "deny", "a dangling link would create its target");
  linkSync(path.join(dir, "README.md"), path.join(dir, ".ticket-hard.md"));
  assert.equal(ticket(".ticket-hard.md").decision, "deny", "a hard link to another file");

  // write_plan has the same weakness through .pi/plan.md and through a linked .pi directory
  mkdirSync(path.join(dir, ".pi"));
  symlinkSync("../README.md", path.join(dir, ".pi", "plan.md"));
  assert.equal(plan().decision, "deny", ".pi/plan.md -> README.md");
  rmSync(path.join(dir, ".pi"), { recursive: true });
  symlinkSync(path.join(dir, "src"), path.join(dir, ".pi"));
  assert.equal(plan().decision, "deny", ".pi -> src/");
});

test("planning-tool link rules apply only while a delivery is active", (t) => {
  const dir = repo(t, { feature: false });
  writeFileSync(path.join(dir, "README.md"), "readme");
  if (!link(t, () => symlinkSync("README.md", path.join(dir, ".ticket-fix.md")))) return;
  assert.equal(piGuardVerdict({ toolName: "write_ticket_file", input: { filename: ".ticket-fix.md" } }, { cwd: dir, env: {} }).decision, "pass");
  assert.equal(piGuardVerdict({ toolName: "write_ticket_file", input: { filename: ".ticket-fix.md" } }, { cwd: dir, env: { PI_DELIVERY_GUARD: "on" } }).decision, "deny");
});

# Pi delivery for Claude Code

A Claude Code plugin, rooted at `pi/` (`.claude-plugin/plugin.json`), that does two things:

1. **Serves the delivery tools** (`scaffold_tasks`, `execute_and_review`, checkpoints, validation, recovery,
   review) through the MCP server in `../mcp`, using `.mcp.json`.
2. **Guards the repository while a delivery is active** with a `PreToolUse` hook (`guard.mjs`): direct source
   edits are blocked and shell commands are restricted, so changes can only arrive through `execute_and_review`.

## Use it

```sh
npm ci --prefix pi/mcp                      # once; the plugin must contain its own dependencies
claude --plugin-dir /absolute/path/to/dotfiles/pi
```

`--plugin-dir` loads the plugin in place. Requires Claude Code 2.1.295 or later (the hook uses
`onFailure: "block"`). Validate it with `claude plugin validate pi`.

Tool names come from Claude Code's plugin naming rule, `mcp__plugin_<plugin>_<server>__<tool>`, so
`execute_and_review` is `mcp__plugin_pi-delivery_pidelivery__execute_and_review`. Pi's names differ
(`mcp__pidelivery__...`); the skills do not yet account for either.

Approvals (`approve_feature_direction` and the other two) appear as an MCP elicitation dialog in an
interactive session. In a non-interactive (`-p`) run Claude Code cancels the request, so they fail closed.

## The trust model, honestly

| Layer | What it is | Pi today | Claude Code with this plugin |
|---|---|---|---|
| Instructions | `SYSTEM.md` and the skills tell the agent not to edit directly | yes | partly (skills not ported yet) |
| **Prevention** | A hook refuses the edit or command before it runs | **no** | **yes (this guard)** |
| Detection | The ledger and `checkpointHistory()` flag any commit that is not an authenticated checkpoint | yes | yes (same shared tools) |

**Pi does not enforce its own "never edit directly" rule.** There is no `tool_call` handler, no excluded tool
and no tool restriction in its settings; the rule is text, backed by detection. This guard is therefore
stronger than what Pi has, and `lib/guard/` is host-neutral so Pi could apply it through its own `tool_call`
event later.

## What the guard does

Active only in a repository with a delivery in progress (a `.scaffold/features/<feature>.<id>/` directory,
found by walking up to the repository root). Elsewhere it does nothing, so ordinary repositories are untouched.

| Tool call | While a delivery is active |
|---|---|
| `Edit`, `Write`, `NotebookEdit`, `MultiEdit` | **Denied.** Use `execute_and_review`. |
| `Bash`, `PowerShell` (incl. Monitor commands) | **Default-deny allowlist.** Read-only commands pass; everything not provably read-only is denied. |
| `git add/commit/push/fetch`, `git checkout -b`, `git restore --staged`, `gh pr create/edit` | **Ask:** a human confirms each one (the publishing exception in `SYSTEM.md`, now enforced). |
| Merges, `--force`/`--delete`/`--all` pushes, pushes to `main`/`master`, `git reset/stash/clean/rebase/merge`, `gh pr merge`, running `scaffold`/`executor`/`review-cli`/`conductor` directly | **Denied.** |
| Everything else (`Read`, `Grep`, MCP tools, ...) | Not touched. |

The guard only ever restricts. It returns deny, ask, or nothing, so Claude Code's normal permission flow still
decides everything it lets through; it never grants access.

**Fails closed.** The hook is registered with `onFailure: "block"`. Claude Code's default is the opposite: a hook
that crashes, times out or cannot start is a non-blocking error and the tool runs. Denials use exit code 2.

`PI_DELIVERY_GUARD` (set by the user in their own environment): `auto` (default), `on` (enforce everywhere) or
`off`. Only exactly `off` disables; a typo such as `0` or `false` leaves the guard on.

## What it does not do

- **It is not a sandbox.** The shell policy is a best-effort allowlist for a fallible agent, not isolation from a
  hostile one. I attacked my own first version and found real bypasses (brace expansion building a `-exec` flag,
  attached short options such as `gh api -XPOST`, `git ls-remote --upload-pack`, and abbreviated long options:
  `sort --outp=f` writes a file on this machine). All are fixed and pinned in `tests/pi-guard.test.mjs`, but
  that is how many I found, not a proof there are no more. For isolation use Claude Code's OS sandbox as well.
- **Other MCP servers are not policed.** A file-writing tool from another server is not blocked.
- **Approval prompts can be auto-answered.** Claude Code has an `Elicitation` hook that can answer MCP dialogs
  without showing them. A project or user setting that auto-accepts would approve a feature direction silently.
  Do not configure one; an administrator's managed settings (`allowManagedHooksOnly`) can restrict which hooks run.
- **The guard can be turned off by whoever controls the session**: `PI_DELIVERY_GUARD=off`, `--plugin-dir`
  omitted, `disableAllHooks`, or editing settings outside a guarded repository.
- **Closing a feature does not deactivate it.** Any entry under `.scaffold/features/` keeps the guard on until
  it is removed or `PI_DELIVERY_GUARD=off` is set.
- **It is deliberately restrictive.** No builds, tests or interpreters from the shell (they go through
  `execute_and_review`, as in Pi), no shell redirection except to `/dev/null`, and Claude Code's memory files
  cannot be written in a guarded repository. PowerShell, which Claude Code uses instead of Bash on Windows
  without Git Bash, is limited to a single `git`/`gh` command or a plain `Get-*` cmdlet.
- **Detection is still the backstop.** If something slips past, drift is reported by `inspect_feature_drift`.

## Verified, and not

Verified: the plugin manifest, hook and MCP entry pass `claude plugin validate` (Claude Code 2.1.322), and
negative controls show that validator rejects a bad `onFailure` and an MCP entry with no command; the policy
against 341 command rows (294 POSIX, 47 PowerShell) and the hook's exit-code contract (`tests/pi-guard.test.mjs`).

**Not verified: the plugin running inside a live Claude Code session.** That a deny actually stops a tool, that
`ask` shows the prompt, that elicitation dialogs appear, and the plugin MCP server's tool names were taken from
the documentation, not observed. Try an `Edit` and a `git commit` in a guarded repository before relying on it.

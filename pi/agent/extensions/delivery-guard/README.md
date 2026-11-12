# delivery-guard

Enforces `SYSTEM.md`'s "never edit source directly" rule in Pi. Until now that rule was only text; nothing stopped
the model calling `write`. The extension is one `tool_call` handler over the policy in `../../lib/guard/`.

## What it does

Only while a Scaffold delivery is active in the repository (a `.scaffold/features/<feature>.<id>/` directory,
found by walking up to the repository root). Elsewhere it does nothing.

| Pi tool call | While a delivery is active |
|---|---|
| `edit`, `write` | **Blocked.** Changes go through `execute_and_review`. The target is resolved exactly as Pi resolves it (`~`, `file://` URLs, Unicode spaces, a leading `@`, relative to the session directory) and then followed through symlinks, so a write that *lands* in an active delivery is caught however it is spelled or reached. |
| `bash`, `powershell` | **Read-only allowlist.** Anything not provably read-only is blocked: no redirection except to `/dev/null`, no interpreters, builds or tests (they run through `execute_and_review`), no `scaffold`/`executor`/`review-cli`/`conductor` directly. |
| `git add/commit/push/fetch`, `git checkout -b`, `gh pr create/edit` | **Asks the user** in Pi's UI. No UI, a "no", a cancel or a crashed prompt all block. |
| merges, force/delete/`--all` pushes, pushes to `main`/`master`, `git reset/stash/clean/rebase/merge`, `gh pr merge` | **Blocked.** |
| `write_ticket_file` | Only `.ticket-<name>.md`, and never through a link. Pi's tool otherwise writes any `*.md` in the working directory, including `README.md`, and follows symlinks. |
| `write_plan` | Allowed, but not through a link (`.pi/plan.md`, or a linked `.pi` directory). |
| `read`, `grep`, `find`, `ls`, `write_plan`, MCP and delivery tools | Not touched. |

A block returns the reason as the tool result, so the model reads it and adapts. It does not end the agent loop.
The guard only restricts: it never grants permission, and an unexpected error blocks rather than allows.

`PI_DELIVERY_GUARD=off` disables it (exactly `off`; a typo such as `0` leaves it on). `on` enforces everywhere.

## Limits

- **It is not a sandbox.** The shell policy is a best-effort allowlist for a fallible agent; see
  `../../../claude/README.md` for how many bypasses attacking the first version found. Pi itself says its tools
  "run with the permissions of the Pi process" and are not sandboxed.
- **It only runs if it loads.** `pi --no-extensions` skips it, and an extension that fails to load is reported
  while Pi carries on *without* it. Check for extension errors after `/reload`.
- **Other extensions' tools are not policed.** Of the packages in `settings.json.template`, `pi-lsp` only suggests
  code actions and `pi-web-access` fetches pages, so none edits files today. A tool added later that writes files
  needs a case in `lib/guard/pi.mjs`.
- **Handler order matters.** Pi runs `tool_call` handlers in extension load order and later handlers see earlier
  mutations of `event.input`, so a later extension could rewrite a command after the guard approved it. Extensions
  are trusted code.
- **Links are checked at the call, not in the writer.** The planning tools still follow links when they write; the guard refuses a
  symlink or hard link on the way (any component of the destination) before they run. That is sufficient because the guard also
  refuses everything that could create a link in between. A hardening of the writers themselves was left to the maintainer.
- Commands you type yourself (for example `!cmd` in the TUI) are the user's, not the model's, and are not guarded.
- Closing a feature does not deactivate it: any entry under `.scaffold/features/` keeps the guard on until removed
  or `PI_DELIVERY_GUARD=off`.
- `SYSTEM.md` is unchanged; the model learns of a block from its reason.

## Verified

Unit tests (`tests/pi-guard.test.mjs`) and **real Pi 1.5.2**, driven by a scripted fake model that emits genuine
tool calls (a custom provider, no network), including Pi's RPC mode to answer the confirmation dialog:

- Control, no guard: `write` into an active delivery **succeeds**. This confirms Pi enforced nothing.
- With the guard: `write`, `edit`, `bash` redirection, `rm` and `scaffold clean` are blocked and the files are
  absent or unchanged; `read` and read-only `bash` still run; a plain repository is untouched; `off` disables it
  and `0` does not.
- `git add && git commit`: the user's **yes** runs it; **no** and **cancel** block it (no commit); with no UI it blocks.
- `write_ticket_file` writes `.ticket-fix.md` and is blocked from overwriting `README.md`.
- Found by review and reproduced on the first version, now blocked: `~/active/x`, `file://` and `@~/` spellings of a write into
  an active delivery from outside it; a symlinked directory leading into one; and `.ticket-fix.md -> README.md` (which
  **overwrote `README.md`**), a hard-linked ticket and a symlinked `.pi/plan.md`. `resolvePiPath` was checked against Pi's own
  resolver on 36 spellings (identical); `tests/pi-guard.test.mjs` pins the results.

**Not verified:** the Windows `powershell` tool, and a real model's behaviour when blocked (the fake model does not retry).

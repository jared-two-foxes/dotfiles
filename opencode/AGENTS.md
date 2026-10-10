# AGENTS.md

## Purpose

This directory in dotfiles is the source of truth for the global OpenCode setup. See README.md for installation. This is configuration maintenance, not an instruction file for every project using OpenCode.

## Structure and deployment

- `agents/` contains the global agent definitions.
- `skills/` contains the global skills.
- `opencode.jsonc` contains MCP, model and plugin configuration (JSON with comments).
- `dcp.jsonc` contains plugin configuration.
- `scripts/` contains the review subprocess adapter and latch helper.
- `tools/review_changes.ts` exposes review-cli to OpenCode.
- `tools/execute_and_review.ts` runs deterministic executor, build, test and review-cli stages. Its script reuses the executor and review adapters.
- `scratch-notes/` contains reference material.

The full Windows installer deploys directory junctions and file symlinks to
`~/.config/opencode/`. The restricted installer deploys copies. Do not use hard
links: Git updates can replace the underlying file and leave hard links stale.
Run `setup.ps1` for an OpenCode-only installation, or `setup.ps1 -Copy` for copies.
Existing conflicting configuration is preserved unless `-Force` is supplied;
forced replacements are backed up. See README.md for commands and dependencies.

Review-cli replaces review-only subagents. The deterministic execution tool
performs mechanical checks; incomplete or indeterminate reviews cannot approve.
The legacy multi-agent TDD pipeline has been retired.

## GitHub Latch

When GitHub Copilot rate-limits you, run the toggle script to swap all `github-copilot/*` models to `opencode/*` equivalents across every agent file:

```powershell
& "$env:USERPROFILE\.config\opencode\scripts\toggle-github-latch.ps1"
```

Run it again to switch back. State is tracked in the installed `~/.config/opencode/latch.json`. Run the installed script so its state corresponds to the deployed agents.

| State | Models in agents | Trigger |
|---|---|---|
| `github` (default) | `github-copilot/claude-sonnet-4.6`, `github-copilot/gpt-5.4`, `github-copilot/gpt-5.3-codex` | Normal operation |
| `opencode` | `opencode/claude-sonnet-4-6`, `opencode/gpt-5.4`, `opencode/gpt-5.3-codex` | Rate-limited on GitHub |

Check current state without toggling:

```powershell
& "$env:USERPROFILE\.config\opencode\scripts\toggle-github-latch.ps1" -Status
```

The latch changes remaining agent model references only. Review provider/model
selection uses the tool argument or REVIEW_MODEL and is not modified by the latch.
The binary requires its own provider credentials in the process environment.

> **Note:** opencode does not hot-reload. Restart after toggling.

## Agent files

Primary agents: `build`, `design`. No custom subagents are deployed.

The Design agent owns the conversation and all executor input generation.
The deterministic `execute_and_review` tool applies one change set, runs
compilation/tests and invokes review-cli directly; no orchestration subagent is
involved. Design owns correction attempts and architecture-change approvals.
The old Linear Orchestrator, Pipeline Runner, Tester and Implementer agents are
removed; `review_changes` remains available for standalone semantic reviews.

Code quality, reuse, structural recommendations and security inspection are
consolidated into `review_changes`. The deterministic execution tool owns
build/test logs and review results. Do not reintroduce parallel review agents.

## opencode.jsonc notes

- MCP secrets use `{file:~/.secrets/<name>}` syntax — the file must exist on the host machine; it is not stored in this repo.
- `compaction`, `explore`, and `general` built-in agents are overridden to use `opencode/gemini-3.1-pro`.

## Dynamic Context Pruning (DCP)

The `@tarquinen/opencode-dcp` plugin is installed to manage conversation context automatically.

### Available commands

| Command | Purpose |
|---|---|
| `/dcp context` | Show current context statistics |
| `/dcp stats` | Show token usage and context window status |
| `/dcp sweep` | Remove obsolete tool outputs from context |
| `/dcp compress` | Compress current context to essential information |
| `/dcp decompress` | Restore compressed context |
| `/dcp recompress` | Re-compress with different settings |

### Design agent integration

The Design agent may use DCP to compress large discovery and review-feedback
context, but must preserve agreed decisions, fixed requirements, original Git
baseline and the current retry count. It does not invoke retired implementation subagents.

### Configuration

Plugin config is deployed as `~/.config/opencode/dcp.jsonc`. Key settings:

| Setting | Default | Description |
|---|---|---|
| `autoCompress` | `true` | Automatically compress when threshold is exceeded |
| `threshold` | `2000` | Line count threshold for auto-compression |
| `preserveLast` | `5` | Number of recent messages to preserve during sweep |

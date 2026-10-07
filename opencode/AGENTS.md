# AGENTS.md

## Purpose

This directory in dotfiles is the source of truth for the global OpenCode setup. See README.md for installation. This is configuration maintenance, not an instruction file for every project using OpenCode.

## Structure and deployment

- `agents/` contains the global agent definitions.
- `skills/` contains the global skills.
- `opencode.jsonc` contains MCP, model and plugin configuration (JSON with comments).
- `dcp.jsonc` contains plugin configuration.
- `scripts/` contains the review subprocess adapter, latch and optional daily-summary helpers.
- `tools/review_changes.ts` exposes review-cli to OpenCode.
- `scratch-notes/` and the Recallium package archive are retained reference material.

The full Windows installer deploys directory junctions and file symlinks to
`~/.config/opencode/`. The restricted installer deploys copies. Do not use hard
links: Git updates can replace the underlying file and leave hard links stale.
Run `setup.ps1` for an OpenCode-only installation, or `setup.ps1 -Copy` for copies.
Existing conflicting configuration is preserved unless `-Force` is supplied;
forced replacements are backed up. See README.md for commands and dependencies.

Review-cli replaces review-only subagents. Preserve explicit mechanical checks
and per-criterion evidence in the pipeline runner; incomplete reviews cannot approve. Agent escalation edits affect the tracked source
in link mode, and installed copies in copy mode. Check and restore agent changes
before committing.

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

Primary agents: `build`, `design`, `linear-orchestrator`, `daily-summary`.
Subagents: `pipeline-runner`, `tester`, `implementer`.

Code quality, reuse, structural recommendations and security inspection are
consolidated into review_changes. The runner owns check logs and criterion evidence.
The old five review agent files are retired; do not add parallel review agents.

Pipeline-runner edits agent model frontmatter during escalation. Preserve its
restore rules; agent bodies and model choices are imported without redesign.

## opencode.jsonc notes

- MCP secrets use `{file:~/.secrets/<name>}` syntax — the file must exist on the host machine; it is not stored in this repo.
- `recallium` MCP requires a local server running on `http://localhost:8001/mcp`.
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

- **Phase 1c:** After reading key source files, run `/dcp compress` if `CODEBASE_CONTEXT` exceeds 2000 lines to keep the context window clean.
- **Phase 3:** Before invoking `pipeline-runner`, run `/dcp sweep` to remove stale tool outputs from Phase 1 discovery.

### Configuration

Plugin config is deployed as `~/.config/opencode/dcp.jsonc`. Key settings:

| Setting | Default | Description |
|---|---|---|
| `autoCompress` | `true` | Automatically compress when threshold is exceeded |
| `threshold` | `2000` | Line count threshold for auto-compression |
| `preserveLast` | `5` | Number of recent messages to preserve during sweep |

## Scheduled Tasks

An optional Windows Task Scheduler job can run the `daily-summary` agent. Installation does not register it automatically.

### Scripts

| Script | Purpose |
|---|---|
| `scripts/run-daily-summary.ps1` | Launcher invoked by Task Scheduler. Runs the agent, captures output, writes a dated log file. |
| `scripts/register-scheduled-task.ps1` | One-time setup script. Registers (or replaces) the scheduled task. |

### Register the task

Run once from the installed configuration (PowerShell 7+):

```powershell
& "$env:USERPROFILE\.config\opencode\scripts\register-scheduled-task.ps1"
```

Default schedule: **23:59 daily**.

### Change the scheduled time

Re-run the registration script with the `-Time` parameter:

```powershell
& "$env:USERPROFILE\.config\opencode\scripts\register-scheduled-task.ps1" -Time "22:00"
```

The task is replaced in-place (`-Force`), so no manual cleanup is needed.

### Log files

Each run writes a dated log to:

```
$env:USERPROFILE\.config\opencode\logs\daily-summary-YYYY-MM-DD.log
```

Log lines are timestamped: `[YYYY-MM-DD HH:mm:ss] <message>`.

### Recallium dependency

The `daily-summary` agent reads memory context from Recallium (`localhost:8001`). The launcher performs a TCP pre-flight check before starting the agent:

- If Recallium **is** reachable → the agent runs with full memory context.
- If Recallium **is not** reachable → a `WARNING` is written to the log and the agent runs anyway (it handles the absence of memory context gracefully). The task does **not** abort.

Recallium must be running at 23:59 for the summary to include memory context. Start it before the scheduled time if needed.

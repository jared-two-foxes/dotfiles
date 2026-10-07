# OpenCode configuration

Imported from the standalone local OpenCode repository. The implementation/planning agents and five skills remain.
Review-only subagents are replaced by review-cli.

## Install

From the dotfiles root, choose the installer appropriate for your machine:

```powershell
.\install\windows-full.ps1 -Machine home
.\install\windows-restricted.ps1 -Machine work
```

The full installer uses junctions for agents, skills, scripts and tools, and symbolic
links for opencode.jsonc and dcp.jsonc. File symlinks require Windows Developer
Mode or administrator rights, like the other full-installer dotfiles. The
restricted installer copies the same files without requiring link privileges.
Only these managed entries are deployed; unrelated files, logs and credentials
in the config directory are left in place.

For OpenCode alone (PowerShell 7+):

```powershell
.\opencode\setup.ps1
.\opencode\setup.ps1 -Copy
.\opencode\setup.ps1 -WhatIf
```

If old configuration is present, installation skips OpenCode until you supply
`-Force`. Forced replacements, including the old opencode.json, are moved to a
unique folder under ~/.config/opencode/backups/. Existing links are moved rather
than deleted recursively. The rest of each full dotfiles install still runs.
`-ConfigDir <path>` on setup.ps1 or install/opencode.ps1 supports custom locations.
Re-run copy installs with -Force to update changed copies. Link installs pick up
source edits; restart OpenCode after updating configuration.

The uploaded opencode.json contains comments, so it is named opencode.jsonc.
The redundant relative skills.paths setting was removed: skills are discovered
from the installed skills directory. No actual secret values are included.

## Dependencies and optional helpers

- Install/authenticate OpenCode and the model providers you use.
- Node/npm/npx are required by the configured MCP servers and plugin setup.
- Configure ~/.secrets/linear-key and ~/.secrets/stripe-key for the enabled MCPs.
- Ollama uses localhost:11434.

Run helpers from ~/.config/opencode/scripts/ so latch state and agent files refer
to the same installation. latch.example.json seeds local latch.json once; installer
reruns preserve its state. In link mode, model toggles and pipeline escalation edit
tracked agent files. In copy mode they edit installed copies.

```powershell
& "$env:USERPROFILE\.config\opencode\scripts\toggle-github-latch.ps1" -Status
```

AGENTS.md is maintenance guidance for this directory and is not deployed as global
OpenCode instructions. scratch-notes/ is retained in Git but not installed. The former standalone .git directory is not imported.

## Review integration

`review_changes` is a global OpenCode tool backed by a shell-free Node subprocess
adapter. It consolidates code review, security inspection, reuse checking and
structural recommendations. The pipeline runner performs mechanical commands and
maps every acceptance criterion to evidence before requesting binary review.
Five retired agent files are backed up and removed during forced installation,
including on copy-based machines. Re-run your installer with -Force after pulling.

Install the binary separately on each machine (Rust/Cargo required for installation):

```powershell
cargo install --git https://github.com/jared-two-foxes/review --locked --package review-cli
review-cli --help
```

Git is required by the adapter. OpenCode provides the JS runtime and tool helper.
The binary must be on the OpenCode process PATH, or set REVIEW_CLI_BIN to its full
executable path. Restart OpenCode after changing environment variables.

The review model is independent of the orchestrator and implementer models. Set
REVIEW_MODEL (default opencode/gpt-5.6-terra) or supply an explicit tool model.
For the default provider, export OPENCODE_API_KEY; openai/<model> uses OPENAI_API_KEY,
ollama/<model> uses the local Ollama endpoint, and copilot/<model> uses credentials
supported by review-cli. OpenCode's stored login is not automatically forwarded.
Do not commit provider credentials.

Normal tasks require a clean starting worktree and retain its initial commit SHA
through all retries. The tool reviews that base against the current working tree,
including new untracked files. Review-only mode requires an explicit baseline and
can instead review a fixed committed target. The tool stores requirements/request
files outside the repository, removes them afterwards, validates result/exit-code
consistency, and rejects results if repository contents change during inspection.

APPROVED plus passing checks and criterion evidence completes normal execution.
CHANGES_REQUESTED sends only blocking findings to the implementer, then repeats
checks and review (two review repair cycles maximum; global five-failure budget).
Suggestions remain future work. INDETERMINATE allows one explicit budget/model
retry; ERROR stops. Neither outcome can approve or fall back to retired agents.
Review-only never applies findings or claims that tests were run.

Current binary limitations: it inspects code with read-only tools, not test/build
execution; criterion coverage in its result is not a typed evidence matrix. That
matrix stays with the runner. Its general review prompt still asks for a concrete
finding, and its specialized test-quality skill currently targets Python files.
The adapter preserves the binary's verdict and does not pretend these limitations
are additional verified guarantees.

Run integration checks from the dotfiles root:

```powershell
node --test tests/review-runner.test.mjs
pwsh -NoProfile -File tests/install-opencode.ps1
```

The subprocess tests use a protocol fixture; they do not spend provider credits or
measure live model review quality.

## Removing the former daily summary

The daily-summary agent and its scheduling helpers are retired. Forced installer
upgrades back up and remove their old installed copies. If you previously
registered the Windows task, remove that registration once on that machine:

```powershell
Unregister-ScheduledTask -TaskName 'OpenCode Daily Summary' -Confirm:$false
```

Existing summary logs are retained.

# OpenCode configuration

Imported from the standalone local OpenCode repository. The 12 agent definitions,
seven skills and workflow/model choices are preserved. This migration does not
integrate review-cli or register scheduled tasks.

## Install

From the dotfiles root, choose the installer appropriate for your machine:

```powershell
.\install\windows-full.ps1 -Machine home
.\install\windows-restricted.ps1 -Machine work
```

The full installer uses junctions for agents, skills and scripts, and symbolic
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
- Recallium is configured at http://localhost:8001/mcp; Ollama uses localhost:11434.
- The bundled recallium-1.2.6.tgz is retained for reference; the MCP configuration
  continues to use npx recallium, as in the uploaded setup.

Run helpers from ~/.config/opencode/scripts/ so latch state and agent files refer
to the same installation. latch.example.json seeds local latch.json once; installer
reruns preserve its state. In link mode, model toggles and pipeline escalation edit
tracked agent files. In copy mode they edit installed copies.

```powershell
& "$env:USERPROFILE\.config\opencode\scripts\toggle-github-latch.ps1" -Status
& "$env:USERPROFILE\.config\opencode\scripts\register-scheduled-task.ps1" -Time "23:59"
```

AGENTS.md is maintenance guidance for this directory and is not deployed as global
OpenCode instructions. scratch-notes/ and the package archive are retained in Git
but not installed. The former standalone .git directory is not imported.

---
name: project-detection
description: Use when an agent needs to derive the current project name (PROJECT_NAME) from the git remote URL. Covers PowerShell (pwsh) and bash normalization. Use at session start before any Recallium or toolchain operations that require PROJECT_NAME.
---

# Project Detection

Derive `PROJECT_NAME` from the current git repository.

## PowerShell / pwsh

Run:

```powershell
git remote get-url origin 2>$null
```

- If the command returns a non-empty URL:
  - Take the last `/`- or `:`-delimited segment.
  - Strip a trailing `.git` suffix.
  - Convert to lowercase.
  - Replace `_` and spaces with `-`.
  - Store the result as `PROJECT_NAME`.
- If the command returns empty (no remote configured):
  - Run: `(Split-Path -Leaf (Get-Location)).ToLower() -replace '[_ ]','-'`
  - Store the result as `PROJECT_NAME`.

## Bash / sh

Run:

```bash
git remote get-url origin 2>/dev/null
```

- If the command returns a non-empty URL (store as `$r`):
  - Run: `basename "$r" .git | tr '[:upper:]' '[:lower:]' | tr '_ ' '-'`
  - Store the result as `PROJECT_NAME`.
- If the command returns empty:
  - Run: `basename "$(pwd)" | tr '[:upper:]' '[:lower:]' | tr '_ ' '-'`
  - Store the result as `PROJECT_NAME`.

## After Detection

Include `PROJECT_NAME` in your opening response or Phase 0 report to the user. It is now available for Recallium memory scoping, session summaries, and reporting.

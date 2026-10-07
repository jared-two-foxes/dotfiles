<#
.SYNOPSIS
    Toggles github-copilot models in agents/*.md to opencode equivalents (and vice versa).
.DESCRIPTION
    Provides a latch to opt out of GitHub Copilot when rate-limited.
    Replaces ALL occurrences of github-copilot model strings throughout each file —
    frontmatter, fallback tables, escalation tables, and restore rules — so that the
    retry/escalation systems cannot attempt to use github-copilot models when latched
    to opencode.
.NOTES
    State is tracked in latch.json at the repo root.
    Only swaps the three specific model pairs — other opencode/* and ollama/* models
    (e.g. gpt-5.5-pro, qwen3-coder) are untouched.
#>

param(
    [switch]$Status
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot
$AgentsDir = Join-Path $RepoRoot "agents"
$LatchFile = Join-Path $RepoRoot "latch.json"

# --- Model pairs: github-copilot <-> opencode ---
# Note: github-copilot uses dots (4.6), opencode uses dashes (4-6) for Claude models
$ModelPairs = @(
    @{ github = "github-copilot/claude-sonnet-4.6"; opencode = "opencode/claude-sonnet-4-6" }
    @{ github = "github-copilot/gpt-5.4";           opencode = "opencode/gpt-5.4" }
    @{ github = "github-copilot/gpt-5.3-codex";     opencode = "opencode/gpt-5.3-codex" }
)

# --- Read current state ---
if (Test-Path $LatchFile) {
    $latch = Get-Content $LatchFile -Raw | ConvertFrom-Json
} else {
    $latch = [PSCustomObject]@{
        state          = "github"
        previous_state = $null
        toggled_at     = $null
    }
}

$currentState = $latch.state

# --- Status mode ---
if ($Status) {
    Write-Host "Current latch state: $currentState" -ForegroundColor Cyan
    Write-Host "Toggled at: $($latch.toggled_at)" -ForegroundColor DarkGray
    exit 0
}

# --- Determine swap direction ---
if ($currentState -eq "github") {
    $fromKey = "github"
    $toKey   = "opencode"
    $newState = "opencode"
} else {
    $fromKey = "opencode"
    $toKey   = "github"
    $newState = "github"
}

Write-Host "Latch state: $currentState -> $newState" -ForegroundColor Yellow
Write-Host ""

# --- Find and update agent files ---
$files = Get-ChildItem -Path $AgentsDir -Filter "*.md" -File
$updated = @()

foreach ($file in $files) {
    $content = Get-Content $file.FullName -Raw
    $changed = $false

    foreach ($pair in $ModelPairs) {
        $from = $pair.$fromKey
        $to   = $pair.$toKey
        if ($content.Contains($from)) {
            $content = $content.Replace($from, $to)
            $changed = $true
        }
    }

    if ($changed) {
        Set-Content -Path $file.FullName -Value $content -NoNewline
        $updated += $file.Name
    }
}

# --- Write latch state ---
$latch.state          = $newState
$latch.previous_state = $currentState
$latch.toggled_at     = (Get-Date -Format "o")

$latch | ConvertTo-Json -Depth 3 | Set-Content -Path $LatchFile -Encoding UTF8

# --- Report ---
if ($updated.Count -eq 0) {
    Write-Host "No files changed (no swappable models found)." -ForegroundColor DarkGray
} else {
    Write-Host "Updated $($updated.Count) file(s):" -ForegroundColor Green
    foreach ($name in $updated) {
        Write-Host "  - $name" -ForegroundColor Green
    }
}
Write-Host ""
Write-Host "LATCH: $currentState -> $newState" -ForegroundColor Cyan

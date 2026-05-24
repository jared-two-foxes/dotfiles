# =============================================================
# modules/functions.ps1 — Utility functions
# =============================================================

# --- Path helpers --------------------------------------------

# Print each entry on its own line
function Show-Path {
    $env:PATH -split ';' | Where-Object { $_ } | Sort-Object
}
Set-Alias -Name path -Value Show-Path

# Add a directory to PATH for the current session
function Add-ToPath {
    param([Parameter(Mandatory)][string]$Dir)
    if (-not ($env:PATH -split ';' -contains $Dir)) {
        $env:PATH = "$Dir;$env:PATH"
        Write-Host "Added to PATH: $Dir" -ForegroundColor Green
    } else {
        Write-Host "Already in PATH: $Dir" -ForegroundColor Yellow
    }
}

# --- File helpers --------------------------------------------

# Recursive grep using ripgrep if available, else Select-String
function Search-Content {
    param(
        [Parameter(Mandatory)][string]$Pattern,
        [string]$Path = '.',
        [string]$Include = '*'
    )
    if (Get-Command rg -ErrorAction SilentlyContinue) {
        rg $Pattern $Path --glob $Include
    } else {
        Get-ChildItem -Path $Path -Recurse -Include $Include |
            Select-String -Pattern $Pattern
    }
}
Set-Alias -Name rgg -Value Search-Content

# Show disk usage of a directory (top-level only)
function Get-DiskUsage {
    param([string]$Path = '.')
    Get-ChildItem $Path |
        ForEach-Object {
            $size = if ($_.PSIsContainer) {
                (Get-ChildItem $_.FullName -Recurse -ErrorAction SilentlyContinue |
                    Measure-Object -Property Length -Sum).Sum
            } else { $_.Length }
            [PSCustomObject]@{ Name = $_.Name; SizeMB = [math]::Round($size/1MB, 2) }
        } | Sort-Object SizeMB -Descending | Format-Table -AutoSize
}
Set-Alias -Name du -Value Get-DiskUsage

# --- Process helpers -----------------------------------------

# Kill process by name
function Stop-Named {
    param([Parameter(Mandatory)][string]$Name)
    Get-Process -Name $Name -ErrorAction SilentlyContinue | Stop-Process -Force
}

# --- Network helpers -----------------------------------------

# Quick HTTP GET (no dependencies)
function Get-Url {
    param([Parameter(Mandatory)][string]$Url)
    Invoke-RestMethod -Uri $Url
}

# --- Environment helpers -------------------------------------

# Pretty-print environment variables, optionally filtered
function Show-Env {
    param([string]$Filter = '')
    Get-ChildItem Env: |
        Where-Object { $_.Name -like "*$Filter*" } |
        Sort-Object Name |
        Format-Table Name, Value -AutoSize
}

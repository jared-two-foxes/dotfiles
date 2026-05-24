# =============================================================
# modules/aliases.ps1 — Shell aliases and short forms
# =============================================================

# --- Navigation ----------------------------------------------
Set-Alias -Name ll   -Value Get-ChildItem
function la  { Get-ChildItem -Force @args }
function l   { Get-ChildItem -Name @args }
function ..  { Set-Location .. }
function ... { Set-Location ..\.. }

# --- Editor --------------------------------------------------
# 'e' opens in the configured $env:EDITOR
function e {
    if ($env:EDITOR) { & $env:EDITOR @args }
    else { notepad @args }
}

# --- Git short forms -----------------------------------------
function g    { git @args }
function gs   { git status -sb @args }
function ga   { git add @args }
function gc   { git commit @args }
function gca  { git commit --amend @args }
function gp   { git push @args }
function gpl  { git pull @args }
function gco  { git checkout @args }
function gbr  { git branch @args }
function glg  { git log --oneline --graph --decorate --all @args }
function gd   { git diff @args }
function gds  { git diff --staged @args }

# --- Utilities -----------------------------------------------
# which equivalent
function which { (Get-Command $args[0] -ErrorAction SilentlyContinue).Source }

# Reload profile
function Reload-Profile { . $PROFILE }
Set-Alias -Name reload -Value Reload-Profile

# Compute file hash quickly
function md5  { Get-FileHash @args -Algorithm MD5 }
function sha1 { Get-FileHash @args -Algorithm SHA1 }
function sha256 { Get-FileHash @args -Algorithm SHA256 }

# Touch (create or update timestamp)
function touch {
    param([string]$Path)
    if (Test-Path $Path) { (Get-Item $Path).LastWriteTime = Get-Date }
    else { New-Item -ItemType File -Path $Path | Out-Null }
}

# Create directory and cd into it
function mkcd {
    param([string]$Path)
    New-Item -ItemType Directory -Path $Path -Force | Out-Null
    Set-Location $Path
}

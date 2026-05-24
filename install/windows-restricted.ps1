#Requires -Version 7
# =============================================================
# install/windows-restricted.ps1
# Restricted Windows install — copies files, no symlinks, no admin.
# Re-run to sync latest changes from the repo.
# =============================================================

[CmdletBinding(SupportsShouldProcess)]
param(
    [switch]$Force  # Overwrite existing files even if unchanged
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# --- Resolve repo root ---------------------------------------
$RepoRoot = Split-Path -Parent $PSScriptRoot

# --- Helpers -------------------------------------------------
function Write-Step  { param($msg) Write-Host "  --> $msg" -ForegroundColor Cyan }
function Write-Ok    { param($msg) Write-Host "  [OK] $msg" -ForegroundColor Green }
function Write-Skip  { param($msg) Write-Host " [SKIP] $msg" -ForegroundColor Yellow }
function Write-Warn  { param($msg) Write-Host " [WARN] $msg" -ForegroundColor Yellow }

function Copy-Dotfile {
    param(
        [string]$Source,
        [string]$Dest
    )
    $destDir = Split-Path $Dest
    if (-not (Test-Path $destDir)) {
        New-Item -ItemType Directory -Path $destDir -Force | Out-Null
    }

    # Skip if identical (avoid unnecessary writes)
    if ((Test-Path $Dest) -and -not $Force) {
        $srcHash  = (Get-FileHash $Source  -Algorithm MD5).Hash
        $dstHash  = (Get-FileHash $Dest    -Algorithm MD5).Hash
        if ($srcHash -eq $dstHash) {
            Write-Skip "$Dest (up to date)"
            return
        }
    }

    Copy-Item -LiteralPath $Source -Destination $Dest -Force
    Write-Ok "$Dest"
}

function Copy-DotfileDir {
    param(
        [string]$Source,
        [string]$Dest
    )
    if (-not (Test-Path $Dest)) {
        New-Item -ItemType Directory -Path $Dest -Force | Out-Null
    }
    Copy-Item -Path (Join-Path $Source '*') -Destination $Dest -Recurse -Force
    Write-Ok "$Dest (directory)"
}

function Copy-Template {
    param([string]$Template, [string]$Dest)
    if (Test-Path $Dest) {
        Write-Skip "$Dest already exists — skipping template copy"
        return
    }
    Copy-Item -LiteralPath $Template -Destination $Dest
    Write-Ok "Created $Dest from template"
}

# --- Git -----------------------------------------------------
Write-Host "`n[Git]" -ForegroundColor White

Copy-Dotfile `
    -Source (Join-Path $RepoRoot 'shared\git\.gitconfig') `
    -Dest   (Join-Path $env:USERPROFILE '.gitconfig')

Copy-Dotfile `
    -Source (Join-Path $RepoRoot 'shared\git\.gitignore_global') `
    -Dest   (Join-Path $env:USERPROFILE '.gitignore_global')

Copy-Template `
    -Template (Join-Path $RepoRoot 'local\git\.gitconfig.local.template') `
    -Dest     (Join-Path $env:USERPROFILE '.gitconfig.local')

# --- Neovim --------------------------------------------------
Write-Host "`n[Neovim]" -ForegroundColor White

$nvimConfigDir = Join-Path $env:LOCALAPPDATA 'nvim'
Copy-DotfileDir `
    -Source (Join-Path $RepoRoot 'shared\nvim') `
    -Dest   $nvimConfigDir

# --- Vim -----------------------------------------------------
Write-Host "`n[Vim]" -ForegroundColor White

Copy-Dotfile `
    -Source (Join-Path $RepoRoot 'shared\vim\.vimrc') `
    -Dest   (Join-Path $env:USERPROFILE '.vimrc')

# --- EditorConfig --------------------------------------------
Write-Host "`n[EditorConfig]" -ForegroundColor White

Copy-Dotfile `
    -Source (Join-Path $RepoRoot 'shared\editorconfig\.editorconfig') `
    -Dest   (Join-Path $env:USERPROFILE '.editorconfig')

# --- Starship ------------------------------------------------
Write-Host "`n[Starship]" -ForegroundColor White

$starshipConfigDir = Join-Path $env:USERPROFILE '.config'
Copy-Dotfile `
    -Source (Join-Path $RepoRoot 'shared\starship\starship.toml') `
    -Dest   (Join-Path $starshipConfigDir 'starship.toml')

# Remind user where to place starship.exe
if (-not (Get-Command starship -ErrorAction SilentlyContinue)) {
    $userBin = Join-Path $env:USERPROFILE 'bin'
    Write-Warn "Starship not found in PATH."
    Write-Warn "If you have starship.exe, place it in: $userBin"
    Write-Warn "The PowerShell prompt module will detect it automatically."
}

# --- PowerShell profile --------------------------------------
Write-Host "`n[PowerShell]" -ForegroundColor White

$psProfileDir    = Split-Path $PROFILE
$psSourceDir     = Join-Path $RepoRoot 'windows\powershell'

Copy-Dotfile `
    -Source (Join-Path $psSourceDir 'Microsoft.PowerShell_profile.ps1') `
    -Dest   $PROFILE

# Copy all modules
$modulesTarget = Join-Path $psProfileDir 'modules'
Copy-DotfileDir `
    -Source (Join-Path $psSourceDir 'modules') `
    -Dest   $modulesTarget

Copy-Template `
    -Template (Join-Path $RepoRoot 'local\powershell\profile.local.ps1.template') `
    -Dest     (Join-Path $psProfileDir 'profile.local.ps1')

# --- VS Code -------------------------------------------------
Write-Host "`n[VS Code]" -ForegroundColor White

$vsCodeUserDir = Join-Path $env:APPDATA 'Code\User'

Copy-Dotfile `
    -Source (Join-Path $RepoRoot 'windows\vscode\settings.json') `
    -Dest   (Join-Path $vsCodeUserDir 'settings.json')

# Install extensions (code CLI doesn't need admin)
$extensionsFile = Join-Path $RepoRoot 'windows\vscode\extensions.txt'
if (Get-Command code -ErrorAction SilentlyContinue) {
    Write-Step "Installing VS Code extensions..."
    Get-Content $extensionsFile |
        Where-Object { $_ -and $_ -notmatch '^\s*#' } |
        ForEach-Object {
            $ext = $_.Trim()
            Write-Step "  $ext"
            code --install-extension $ext --force 2>&1 | Out-Null
        }
    Write-Ok "Extensions installed"
} else {
    Write-Skip "VS Code (code) not found in PATH — skipping extension install"
}

# --- Windows Terminal ----------------------------------------
Write-Host "`n[Windows Terminal]" -ForegroundColor White

$wtSettingsDir = Join-Path $env:LOCALAPPDATA 'Packages\Microsoft.WindowsTerminal_8wekyb3d8bbwe\LocalState'
if (Test-Path $wtSettingsDir) {
    Copy-Dotfile `
        -Source (Join-Path $RepoRoot 'windows\terminal\settings.json') `
        -Dest   (Join-Path $wtSettingsDir 'settings.json')
} else {
    Write-Skip "Windows Terminal not found — skipping"
}

# --- Done ----------------------------------------------------
Write-Host "`nInstall complete." -ForegroundColor Green
Write-Host "NOTE: This is a copy-based install. Re-run this script after pulling repo changes."
Write-Host "Restart your shell for all changes to take effect.`n"

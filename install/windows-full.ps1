#Requires -Version 7
# =============================================================
# install/windows-full.ps1
# Full-access Windows install — uses symlinks.
# Requires: PowerShell 7+, Developer Mode or admin rights.
# =============================================================

[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)]
    [ValidateSet('home', 'work')]
    [string]$Machine,   # Machine profile to deploy (home|work)
    [switch]$Force      # Overwrite existing files/links
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# --- Resolve repo root ---------------------------------------
$RepoRoot = Split-Path -Parent $PSScriptRoot

# --- Helpers -------------------------------------------------
function Write-Step  { param($msg) Write-Host "  --> $msg" -ForegroundColor Cyan }
function Write-Ok    { param($msg) Write-Host "  [OK] $msg" -ForegroundColor Green }
function Write-Skip  { param($msg) Write-Host " [SKIP] $msg" -ForegroundColor Yellow }
function Write-Fail  { param($msg) Write-Host " [FAIL] $msg" -ForegroundColor Red }

function New-Symlink {
    param(
        [string]$Target,   # Source file in repo
        [string]$Link      # Destination path on system
    )
    $linkDir = Split-Path $Link
    if (-not (Test-Path $linkDir)) {
        New-Item -ItemType Directory -Path $linkDir -Force | Out-Null
    }

    if (Test-Path $Link) {
        if ($Force) {
            Remove-Item -LiteralPath $Link -Force -Recurse
        } else {
            Write-Skip "$Link already exists (use -Force to overwrite)"
            return
        }
    }

    $itemType = if (Test-Path $Target -PathType Container) { 'Junction' } else { 'SymbolicLink' }
    New-Item -ItemType $itemType -Path $Link -Target $Target -Force | Out-Null
    Write-Ok "$Link -> $Target"
}

function Copy-MachineProfile {
    param(
        [string]$File,  # Filename within local/machines/$Machine/
        [string]$Dest   # Destination path on system
    )
    $machineFile  = Join-Path $RepoRoot "local\machines\$Machine\$File"
    $templateFile = Join-Path $RepoRoot "local\git\.gitconfig.local.template"  # generic fallback

    # Pick the most specific source available
    $source = if (Test-Path $machineFile) {
        $machineFile
    } else {
        # Try to find a matching template as fallback
        $candidate = Join-Path $RepoRoot "local\$($File -replace '^\.', '' -replace '$', '.template')"
        if (Test-Path $candidate) { $candidate } else { $null }
    }

    if (-not $source) {
        Write-Warn "No machine profile or template found for $File — skipping"
        return
    }

    $destDir = Split-Path $Dest
    if (-not (Test-Path $destDir)) {
        New-Item -ItemType Directory -Path $destDir -Force | Out-Null
    }

    if ((Test-Path $Dest) -and -not $Force) {
        Write-Skip "$Dest already exists (use -Force to overwrite)"
        return
    }

    Copy-Item -LiteralPath $source -Destination $Dest -Force
    Write-Ok "$Dest (from machines\$Machine\$File)"
}

# --- Check for symlink capability ----------------------------
Write-Host "`nChecking symlink capability..." -ForegroundColor White
$testLink = Join-Path $env:TEMP 'dotfiles_symlink_test'
try {
    New-Item -ItemType SymbolicLink -Path $testLink -Target $PSCommandPath -Force | Out-Null
    Remove-Item $testLink -Force
} catch {
    Write-Fail "Cannot create symlinks. Enable Developer Mode or run as Administrator."
    Write-Host "  Alternatively, use install\windows-restricted.ps1 (copy-based install)."
    exit 1
}
Write-Ok "Symlinks available"

# --- Git -----------------------------------------------------
Write-Host "`n[Git]" -ForegroundColor White

New-Symlink `
    -Target (Join-Path $RepoRoot 'shared\git\.gitconfig') `
    -Link   (Join-Path $env:USERPROFILE '.gitconfig')

New-Symlink `
    -Target (Join-Path $RepoRoot 'shared\git\.gitignore_global') `
    -Link   (Join-Path $env:USERPROFILE '.gitignore_global')

Copy-MachineProfile `
    -File '.gitconfig.local' `
    -Dest (Join-Path $env:USERPROFILE '.gitconfig.local')

# --- Neovim --------------------------------------------------
Write-Host "`n[Neovim]" -ForegroundColor White

$nvimConfigDir = Join-Path $env:LOCALAPPDATA 'nvim'
New-Symlink `
    -Target (Join-Path $RepoRoot 'shared\nvim') `
    -Link   $nvimConfigDir

# --- Vim -----------------------------------------------------
Write-Host "`n[Vim]" -ForegroundColor White

New-Symlink `
    -Target (Join-Path $RepoRoot 'shared\vim\.vimrc') `
    -Link   (Join-Path $env:USERPROFILE '.vimrc')

# --- EditorConfig --------------------------------------------
Write-Host "`n[EditorConfig]" -ForegroundColor White

New-Symlink `
    -Target (Join-Path $RepoRoot 'shared\editorconfig\.editorconfig') `
    -Link   (Join-Path $env:USERPROFILE '.editorconfig')

# --- Starship ------------------------------------------------
Write-Host "`n[Starship]" -ForegroundColor White

$starshipConfigDir = Join-Path $env:USERPROFILE '.config'
New-Symlink `
    -Target (Join-Path $RepoRoot 'shared\starship\starship.toml') `
    -Link   (Join-Path $starshipConfigDir 'starship.toml')

# --- PowerShell profile --------------------------------------
Write-Host "`n[PowerShell]" -ForegroundColor White

# Determine the PowerShell profile directory
$psProfileDir = Split-Path $PROFILE
$psProfileTarget = Join-Path $RepoRoot 'windows\powershell\Microsoft.PowerShell_profile.ps1'

New-Symlink `
    -Target $psProfileTarget `
    -Link   $PROFILE

# Symlink the modules directory alongside the profile
New-Symlink `
    -Target (Join-Path $RepoRoot 'windows\powershell\modules') `
    -Link   (Join-Path $psProfileDir 'modules')

Copy-MachineProfile `
    -File 'profile.local.ps1' `
    -Dest (Join-Path $psProfileDir 'profile.local.ps1')

# --- VS Code -------------------------------------------------
Write-Host "`n[VS Code]" -ForegroundColor White

$vsCodeUserDir = Join-Path $env:APPDATA 'Code\User'

New-Symlink `
    -Target (Join-Path $RepoRoot 'windows\vscode\settings.json') `
    -Link   (Join-Path $vsCodeUserDir 'settings.json')

# Install extensions
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
    New-Symlink `
        -Target (Join-Path $RepoRoot 'windows\terminal\settings.json') `
        -Link   (Join-Path $wtSettingsDir 'settings.json')
} else {
    Write-Skip "Windows Terminal not found — skipping"
}

# --- Done ----------------------------------------------------
Write-Host "`nInstall complete." -ForegroundColor Green
Write-Host "Restart your shell for all changes to take effect.`n"

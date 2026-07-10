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

function Test-WingetPackageInstalled {
    param([string]$Id)
    winget list --id $Id -e --accept-source-agreements 2>$null | Out-Null
    return ($LASTEXITCODE -eq 0)
}

function Install-WingetPackage {
    param(
        [string]$Id,       # winget package identifier
        [string]$Name,     # Display name for log output
        [string]$Scope,    # Optional: 'user' or 'machine'
        [string]$Override, # Optional: installer-specific override args (e.g. VS Build Tools workloads)
        [string]$Command   # Optional: CLI command to check first (any installed version counts — no version matching yet)
    )
    if ($Command -and (Get-Command $Command -ErrorAction SilentlyContinue)) {
        Write-Skip "$Name already installed ($Command found on PATH)"
        return
    }

    if (Test-WingetPackageInstalled -Id $Id) {
        Write-Skip "$Name already installed"
        return
    }

    Write-Step "Installing $Name..."
    $wingetArgs = @('install', '--id', $Id, '-e', '--silent', '--accept-package-agreements', '--accept-source-agreements')
    if ($Scope)    { $wingetArgs += @('--scope', $Scope) }
    if ($Override) { $wingetArgs += @('--override', $Override) }

    $proc = Start-Process winget -ArgumentList $wingetArgs -Wait -PassThru -NoNewWindow
    if ($proc.ExitCode -eq 0) {
        Write-Ok "$Name"
    } else {
        Write-Skip "$Name (winget exit code $($proc.ExitCode))"
    }
}

function Install-NerdFont {
    param(
        [string]$ReleaseAsset = 'CascadiaCode',             # nerd-fonts release zip name
        [string]$FilePrefix   = 'CaskaydiaCoveNerdFont-'    # ttf filename prefix to install (non-Mono variant)
    )
    $userFontsDir = Join-Path $env:LOCALAPPDATA 'Microsoft\Windows\Fonts'
    if (Test-Path (Join-Path $userFontsDir "${FilePrefix}Regular.ttf")) {
        Write-Skip "CaskaydiaCove Nerd Font already installed"
        return
    }

    Write-Step "Downloading CaskaydiaCove Nerd Font..."
    $zipPath    = Join-Path $env:TEMP "$ReleaseAsset.zip"
    $extractDir = Join-Path $env:TEMP "$ReleaseAsset-NF"
    try {
        Invoke-WebRequest -Uri "https://github.com/ryanoasis/nerd-fonts/releases/latest/download/$ReleaseAsset.zip" -OutFile $zipPath -UseBasicParsing
    } catch {
        Write-Skip "Could not download Nerd Font (no network?) — skipping"
        return
    }

    if (Test-Path $extractDir) { Remove-Item $extractDir -Recurse -Force }
    Expand-Archive -Path $zipPath -DestinationPath $extractDir -Force
    New-Item -ItemType Directory -Path $userFontsDir -Force | Out-Null

    $shell       = New-Object -ComObject Shell.Application
    $fontsFolder = $shell.Namespace(0x14)
    $fontFiles   = Get-ChildItem $extractDir -Filter "$FilePrefix*.ttf"
    foreach ($f in $fontFiles) {
        Copy-Item $f.FullName -Destination $userFontsDir -Force
        $fontsFolder.CopyHere($f.FullName, 0x10)
    }

    Remove-Item $zipPath -Force -ErrorAction SilentlyContinue
    Remove-Item $extractDir -Recurse -Force -ErrorAction SilentlyContinue
    Write-Ok "Installed $($fontFiles.Count) CaskaydiaCove Nerd Font files"
}

# --- Check for symlink capability ----------------------------
Write-Host "
Checking symlink capability..." -ForegroundColor White
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

# --- Applications ----------------------------------------------
Write-Host "
[Applications]" -ForegroundColor White

if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    Write-Skip "winget not found — skipping application installs"
} else {
    Install-WingetPackage -Id 'Git.Git'                    -Name 'Git'          -Command 'git'
    Install-WingetPackage -Id 'Python.Python.3.13'         -Name 'Python'       -Command 'python'
    Install-WingetPackage -Id 'Rustlang.Rustup'            -Name 'Rust (rustup)' -Command 'rustc'
    Install-WingetPackage -Id 'Neovim.Neovim'              -Name 'Neovim'       -Command 'nvim'
    Install-WingetPackage -Id 'Microsoft.VisualStudioCode' -Name 'VS Code'      -Command 'code'
    Install-WingetPackage `
        -Id       'Microsoft.VisualStudio.2022.BuildTools' `
        -Name     'Visual Studio Build Tools (C++)' `
        -Override '--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended'

    # Build tooling
    Install-WingetPackage -Id 'Kitware.CMake'     -Name 'CMake' -Command 'cmake'
    Install-WingetPackage -Id 'Ninja-build.Ninja'  -Name 'Ninja' -Command 'ninja'

    # Shell / terminal
    Install-WingetPackage -Id 'Starship.Starship'         -Name 'Starship'         -Command 'starship'
    Install-WingetPackage -Id 'Microsoft.WindowsTerminal' -Name 'Windows Terminal' -Command 'wt'

    # CLI tools
    Install-WingetPackage -Id 'BurntSushi.ripgrep.MSVC' -Name 'ripgrep' -Command 'rg'
    Install-WingetPackage -Id 'junegunn.fzf'            -Name 'fzf'     -Command 'fzf'
    Install-WingetPackage -Id 'sharkdp.fd'              -Name 'fd'      -Command 'fd'
    Install-WingetPackage -Id 'jqlang.jq'               -Name 'jq'      -Command 'jq'
    Install-WingetPackage -Id 'JesseDuffield.lazygit'   -Name 'lazygit' -Command 'lazygit'

    # Containers / Linux
    Install-WingetPackage -Id 'Docker.DockerDesktop' -Name 'Docker Desktop' -Command 'docker'
    Install-WingetPackage -Id 'Microsoft.WSL'        -Name 'WSL'            -Command 'wsl'

    # AI agent tools
    Install-WingetPackage -Id 'Anthropic.Claude'    -Name 'Claude (desktop)'
    Install-WingetPackage -Id 'GitHub.Copilot'      -Name 'GitHub Copilot CLI'
    Install-WingetPackage -Id 'SST.OpenCodeDesktop' -Name 'OpenCode' -Command 'opencode'
}

# --- Fonts -------------------------------------------------------
Write-Host "
[Fonts]" -ForegroundColor White

Install-NerdFont

# --- Git -----------------------------------------------------
Write-Host "
[Git]" -ForegroundColor White

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
Write-Host "
[Neovim]" -ForegroundColor White

$nvimConfigDir = Join-Path $env:LOCALAPPDATA 'nvim'
New-Symlink `
    -Target (Join-Path $RepoRoot 'shared\nvim') `
    -Link   $nvimConfigDir

# --- Vim -----------------------------------------------------
Write-Host "
[Vim]" -ForegroundColor White

New-Symlink `
    -Target (Join-Path $RepoRoot 'shared\vim\.vimrc') `
    -Link   (Join-Path $env:USERPROFILE '.vimrc')

# --- EditorConfig --------------------------------------------
Write-Host "
[EditorConfig]" -ForegroundColor White

New-Symlink `
    -Target (Join-Path $RepoRoot 'shared\editorconfig\.editorconfig') `
    -Link   (Join-Path $env:USERPROFILE '.editorconfig')

# --- Starship ------------------------------------------------
Write-Host "
[Starship]" -ForegroundColor White

$starshipConfigDir = Join-Path $env:USERPROFILE '.config'
New-Symlink `
    -Target (Join-Path $RepoRoot 'shared\starship\starship.toml') `
    -Link   (Join-Path $starshipConfigDir 'starship.toml')

# --- PowerShell profile --------------------------------------
Write-Host "
[PowerShell]" -ForegroundColor White

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
Write-Host "
[VS Code]" -ForegroundColor White

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

# --- Copilot custom agents ------------------------------------
Write-Host "
[Copilot Agents]" -ForegroundColor White

New-Symlink `
    -Target (Join-Path $RepoRoot 'agents') `
    -Link   (Join-Path $vsCodeUserDir 'agents')

# --- Copilot prompts -----------------------------------------
Write-Host "
[Copilot Prompts]" -ForegroundColor White

New-Symlink `
    -Target (Join-Path $RepoRoot 'prompts') `
    -Link   (Join-Path $vsCodeUserDir 'prompts')

# --- Templates -----------------------------------------------
Write-Host "
[Templates]" -ForegroundColor White

New-Symlink `
    -Target (Join-Path $RepoRoot 'templates') `
    -Link   (Join-Path $env:USERPROFILE '.dotfiles\templates')

# --- ticket-pipeline --------------------------------------------
Write-Host "
[ticket-pipeline]" -ForegroundColor White

# ticket-pipeline/ is a real Python project (see its pyproject.toml),
# not a flat script directory - no longer symlinked into ~/bin (the
# "drop portable executables here" folder, see env.ps1): an editable
# install is what makes `scaffold` (the single dispatcher command for
# push_ticket, review-ticket, etc. - see ticket_pipeline/cli.py) runnable
# as a bare command now, via the console-script shim pip puts on PATH
# (see env.ps1's PATH entry for the pip user Scripts directory), not via a
# copy or symlink into ~/bin. This must stay an editable (-e) install:
# pipeline_lib.PROMPTS_DIR and bench.py's fixtures dir are resolved
# relative to the source tree at import time (see the note in
# pyproject.toml), which only stays valid if the source isn't copied
# into site-packages.
$ticketPipelineProject = Join-Path $RepoRoot 'ticket-pipeline'
if (Get-Command python -ErrorAction SilentlyContinue) {
    Write-Step "Installing ticket_pipeline as an editable package..."
    python -m pip install --user -e $ticketPipelineProject --quiet
    if ($LASTEXITCODE -eq 0) {
        Write-Ok "ticket_pipeline editable install"
    } else {
        Write-Fail "ticket_pipeline editable install (pip exit code $LASTEXITCODE)"
    }
} else {
    Write-Skip "python not found on PATH - skipping ticket_pipeline editable install"
}

# --- Windows Terminal ----------------------------------------
Write-Host "
[Windows Terminal]" -ForegroundColor White

$wtSettingsDir = Join-Path $env:LOCALAPPDATA 'Packages\Microsoft.WindowsTerminal_8wekyb3d8bbwe\LocalState'
if (Test-Path $wtSettingsDir) {
    New-Symlink `
        -Target (Join-Path $RepoRoot 'windows\terminal\settings.json') `
        -Link   (Join-Path $wtSettingsDir 'settings.json')
} else {
    Write-Skip "Windows Terminal not found — skipping"
}

# --- Done ----------------------------------------------------
Write-Host "
Install complete." -ForegroundColor Green
Write-Host "Restart your shell for all changes to take effect.
"

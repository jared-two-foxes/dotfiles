#Requires -Version 7
# =============================================================
# install/windows-restricted.ps1
# Restricted Windows install — copies files, no symlinks, no admin.
# Re-run to sync latest changes from the repo.
# =============================================================

[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)]
    [ValidateSet('home', 'work')]
    [string]$Machine,   # Machine profile to deploy (home|work)
    [switch]$Force      # Overwrite existing files even if unchanged
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

function Copy-MachineProfile {
    param(
        [string]$File,  # Filename within local/machines/$Machine/
        [string]$Dest   # Destination path on system
    )
    $machineFile = Join-Path $RepoRoot "local\machines\$Machine\$File"

    if (-not (Test-Path $machineFile)) {
        Write-Warn "No machine profile found for $File in machines\$Machine\ — skipping"
        return
    }

    $destDir = Split-Path $Dest
    if (-not (Test-Path $destDir)) {
        New-Item -ItemType Directory -Path $destDir -Force | Out-Null
    }

    if ((Test-Path $Dest) -and -not $Force) {
        $srcHash = (Get-FileHash $machineFile -Algorithm MD5).Hash
        $dstHash = (Get-FileHash $Dest        -Algorithm MD5).Hash
        if ($srcHash -eq $dstHash) {
            Write-Skip "$Dest (up to date)"
            return
        }
    }

    Copy-Item -LiteralPath $machineFile -Destination $Dest -Force
    Write-Ok "$Dest (from machines\$Machine\$File)"
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
        Write-Skip "$Name (winget exit code $($proc.ExitCode); some packages don't support user scope without admin)"
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

# --- Applications ----------------------------------------------
Write-Host "
[Applications]" -ForegroundColor White

if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    Write-Skip "winget not found — skipping application installs"
} else {
    Install-WingetPackage -Id 'Git.Git'                    -Name 'Git'           -Scope 'user' -Command 'git'
    Install-WingetPackage -Id 'Python.Python.3.13'         -Name 'Python'        -Scope 'user' -Command 'python'
    Install-WingetPackage -Id 'Rustlang.Rustup'            -Name 'Rust (rustup)' -Scope 'user' -Command 'rustc'
    Install-WingetPackage -Id 'Neovim.Neovim'              -Name 'Neovim'        -Scope 'user' -Command 'nvim'
    Install-WingetPackage -Id 'Microsoft.VisualStudioCode' -Name 'VS Code'       -Scope 'user' -Command 'code'
    Install-WingetPackage `
        -Id       'Microsoft.VisualStudio.2022.BuildTools' `
        -Name     'Visual Studio Build Tools (C++)' `
        -Scope    'user' `
        -Override '--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended'

    # Build tooling
    Install-WingetPackage -Id 'Kitware.CMake'    -Name 'CMake'  -Scope 'user' -Command 'cmake'
    Install-WingetPackage -Id 'Ninja-build.Ninja' -Name 'Ninja' -Scope 'user' -Command 'ninja'

    # Shell / terminal
    Install-WingetPackage -Id 'Starship.Starship'         -Name 'Starship'         -Scope 'user' -Command 'starship'
    Install-WingetPackage -Id 'Microsoft.WindowsTerminal' -Name 'Windows Terminal' -Scope 'user' -Command 'wt'

    # CLI tools
    Install-WingetPackage -Id 'BurntSushi.ripgrep.MSVC' -Name 'ripgrep' -Scope 'user' -Command 'rg'
    Install-WingetPackage -Id 'junegunn.fzf'            -Name 'fzf'     -Scope 'user' -Command 'fzf'
    Install-WingetPackage -Id 'sharkdp.fd'              -Name 'fd'      -Scope 'user' -Command 'fd'
    Install-WingetPackage -Id 'jqlang.jq'               -Name 'jq'      -Scope 'user' -Command 'jq'
    Install-WingetPackage -Id 'JesseDuffield.lazygit'   -Name 'lazygit' -Scope 'user' -Command 'lazygit'

    # Containers / Linux
    Install-WingetPackage -Id 'Docker.DockerDesktop' -Name 'Docker Desktop' -Scope 'user' -Command 'docker'
    Install-WingetPackage -Id 'Microsoft.WSL'        -Name 'WSL'            -Scope 'user' -Command 'wsl'

    # AI agent tools
    Install-WingetPackage -Id 'Anthropic.Claude'    -Name 'Claude (desktop)'   -Scope 'user'
    Install-WingetPackage -Id 'GitHub.Copilot'      -Name 'GitHub Copilot CLI' -Scope 'user'
    Install-WingetPackage -Id 'SST.OpenCodeDesktop' -Name 'OpenCode'          -Scope 'user' -Command 'opencode'
}

# --- Fonts -------------------------------------------------------
Write-Host "
[Fonts]" -ForegroundColor White

Install-NerdFont

# --- Git -----------------------------------------------------
Write-Host "
[Git]" -ForegroundColor White

Copy-Dotfile `
    -Source (Join-Path $RepoRoot 'shared\git\.gitconfig') `
    -Dest   (Join-Path $env:USERPROFILE '.gitconfig')

Copy-Dotfile `
    -Source (Join-Path $RepoRoot 'shared\git\.gitignore_global') `
    -Dest   (Join-Path $env:USERPROFILE '.gitignore_global')

Copy-MachineProfile `
    -File '.gitconfig.local' `
    -Dest (Join-Path $env:USERPROFILE '.gitconfig.local')

# --- Neovim --------------------------------------------------
Write-Host "
[Neovim]" -ForegroundColor White

$nvimConfigDir = Join-Path $env:LOCALAPPDATA 'nvim'
Copy-DotfileDir `
    -Source (Join-Path $RepoRoot 'shared\nvim') `
    -Dest   $nvimConfigDir

# --- Vim -----------------------------------------------------
Write-Host "
[Vim]" -ForegroundColor White

Copy-Dotfile `
    -Source (Join-Path $RepoRoot 'shared\vim\.vimrc') `
    -Dest   (Join-Path $env:USERPROFILE '.vimrc')

# --- EditorConfig --------------------------------------------
Write-Host "
[EditorConfig]" -ForegroundColor White

Copy-Dotfile `
    -Source (Join-Path $RepoRoot 'shared\editorconfig\.editorconfig') `
    -Dest   (Join-Path $env:USERPROFILE '.editorconfig')

# --- Starship ------------------------------------------------
Write-Host "
[Starship]" -ForegroundColor White

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
Write-Host "
[PowerShell]" -ForegroundColor White

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

Copy-MachineProfile `
    -File 'profile.local.ps1' `
    -Dest (Join-Path $psProfileDir 'profile.local.ps1')

# --- VS Code -------------------------------------------------
Write-Host "
[VS Code]" -ForegroundColor White

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

# --- Copilot custom agents ------------------------------------
Write-Host "
[Copilot Agents]" -ForegroundColor White

Copy-DotfileDir `
    -Source (Join-Path $RepoRoot 'agents') `
    -Dest   (Join-Path $vsCodeUserDir 'agents')

# --- Copilot prompts -----------------------------------------
Write-Host "
[Copilot Prompts]" -ForegroundColor White

Copy-DotfileDir `
    -Source (Join-Path $RepoRoot 'prompts') `
    -Dest   (Join-Path $vsCodeUserDir 'prompts')

# --- Templates -----------------------------------------------
Write-Host "
[Templates]" -ForegroundColor White

Copy-DotfileDir `
    -Source (Join-Path $RepoRoot 'templates') `
    -Dest   (Join-Path $env:USERPROFILE '.dotfiles\templates')

# --- ticket-pipeline --------------------------------------------
Write-Host "
[ticket-pipeline]" -ForegroundColor White

# ticket-pipeline/ is a real Python project (see its pyproject.toml),
# not a flat script directory - no longer copied into ~/bin (the
# "drop portable executables here" folder, see env.ps1): an editable
# install is what makes push_ticket, review-ticket, etc. runnable as
# bare commands now, via console-script shims pip puts on PATH (see
# env.ps1's PATH entry for the pip user Scripts directory), not via a
# copy into ~/bin. Must stay editable (-e): see the note in
# pyproject.toml about why PROMPTS_DIR/fixtures resolution depends on
# the source tree staying in place.
$ticketPipelineProject = Join-Path $RepoRoot 'ticket-pipeline'
if (Get-Command python -ErrorAction SilentlyContinue) {
    Write-Step "Installing ticket_pipeline as an editable package..."
    python -m pip install --user -e $ticketPipelineProject --quiet
    if ($LASTEXITCODE -eq 0) {
        Write-Ok "ticket_pipeline editable install"
    } else {
        Write-Warn "ticket_pipeline editable install (pip exit code $LASTEXITCODE)"
    }
} else {
    Write-Skip "python not found on PATH - skipping ticket_pipeline editable install"
}

# --- Windows Terminal ----------------------------------------
Write-Host "
[Windows Terminal]" -ForegroundColor White

$wtSettingsDir = Join-Path $env:LOCALAPPDATA 'Packages\Microsoft.WindowsTerminal_8wekyb3d8bbwe\LocalState'
if (Test-Path $wtSettingsDir) {
    Copy-Dotfile `
        -Source (Join-Path $RepoRoot 'windows\terminal\settings.json') `
        -Dest   (Join-Path $wtSettingsDir 'settings.json')
} else {
    Write-Skip "Windows Terminal not found — skipping"
}

# --- Done ----------------------------------------------------
Write-Host "
Install complete." -ForegroundColor Green
Write-Host "NOTE: This is a copy-based install. Re-run this script after pulling repo changes."
Write-Host "Restart your shell for all changes to take effect.
"

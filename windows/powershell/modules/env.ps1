# =============================================================
# modules/env.ps1 — Environment variables and PATH additions
# Non-secret values only. Secrets go in profile.local.ps1
# =============================================================

# User-local bin directory — drop portable executables here
# (e.g. starship.exe, fd.exe, rg.exe on restricted machines)
$UserBin = Join-Path $env:USERPROFILE 'bin'
if (Test-Path $UserBin) {
    $env:PATH = "$UserBin;$env:PATH"
}

# `pip install --user` (see install/*.ps1's editable install of
# bin/pyproject.toml's ticket_pipeline package) puts console-script
# shims - push_ticket, review-ticket, etc. - in this per-Python-version
# Scripts directory, not on PATH by default. Globbed rather than
# invoking `python -m site --user-base` to avoid a subprocess spawn on
# every shell start.
Get-ChildItem -Path (Join-Path $env:APPDATA 'Python') -Filter 'Python3*' -Directory -ErrorAction SilentlyContinue |
    ForEach-Object {
        $pyUserScripts = Join-Path $_.FullName 'Scripts'
        if (Test-Path $pyUserScripts) {
            $env:PATH = "$pyUserScripts;$env:PATH"
        }
    }

# Prefer nvim as the default editor; fall back to vim, then notepad
if (Get-Command nvim -ErrorAction SilentlyContinue) {
    $env:EDITOR  = 'nvim'
    $env:VISUAL  = 'nvim'
} elseif (Get-Command vim -ErrorAction SilentlyContinue) {
    $env:EDITOR  = 'vim'
    $env:VISUAL  = 'vim'
}

# Pager
if (Get-Command less -ErrorAction SilentlyContinue) {
    $env:PAGER = 'less'
}

# ripgrep config file
$rgConfig = Join-Path $env:USERPROFILE '.ripgreprc'
if (Test-Path $rgConfig) {
    $env:RIPGREP_CONFIG_PATH = $rgConfig
}

# Opt out of telemetry for common tools
$env:DOTNET_CLI_TELEMETRY_OPTOUT = '1'
$env:POWERSHELL_TELEMETRY_OPTOUT = '1'

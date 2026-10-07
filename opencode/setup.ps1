#Requires -Version 7
# OpenCode-only entry point; full dotfiles installs use the same deployment script.
[CmdletBinding(SupportsShouldProcess)]
param(
    [switch]$Copy,
    [switch]$Force,
    [string]$ConfigDir = (Join-Path $env:USERPROFILE '.config/opencode')
)
$mode = if ($Copy) { 'Copy' } else { 'Link' }
& (Join-Path (Split-Path -Parent $PSScriptRoot) 'install/opencode.ps1') `
    -Mode $mode -ConfigDir $ConfigDir -Force:$Force -WhatIf:$WhatIfPreference

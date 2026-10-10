#Requires -Version 7
# Install the shared Conductor CLI from its own GitHub repository.
[CmdletBinding(SupportsShouldProcess)]
param(
    [switch]$Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
    Write-Warning 'Cargo not found on PATH; skipping conductor installation.'
    return
}

if (-not $Force -and (Get-Command conductor -CommandType Application -ErrorAction SilentlyContinue)) {
    Write-Host '  [SKIP] conductor already installed (use -Force to update)'
    return
}

if (-not $PSCmdlet.ShouldProcess('conductor', 'Install Rust CLI from jared-two-foxes/conductor')) {
    return
}

# Conductor does not currently commit a Cargo.lock. Do not use --locked until it does.
$argsForCargo = @('install', '--git', 'https://github.com/jared-two-foxes/conductor.git')
if ($Force) { $argsForCargo += '--force' }

& cargo @argsForCargo
if ($LASTEXITCODE -ne 0) {
    Write-Warning "conductor installation failed (cargo exit code $LASTEXITCODE)"
    return
}

Write-Host '  [OK] conductor installed'

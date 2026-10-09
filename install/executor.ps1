#Requires -Version 7
# Install the standalone executor CLI from its own GitHub repository.
[CmdletBinding(SupportsShouldProcess)]
param(
    [switch]$Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
    Write-Warning 'Cargo not found on PATH; skipping executor installation.'
    return
}

if (-not $Force -and (Get-Command executor -CommandType Application -ErrorAction SilentlyContinue)) {
    Write-Host '  [SKIP] executor already installed (use -Force to update)'
    return
}

if (-not $PSCmdlet.ShouldProcess('executor', 'Install Rust CLI from jared-two-foxes/executor')) {
    return
}

$argsForCargo = @('install', '--git', 'https://github.com/jared-two-foxes/executor.git', '--locked')
if ($Force) { $argsForCargo += '--force' }

& cargo @argsForCargo
if ($LASTEXITCODE -ne 0) {
    Write-Warning "executor installation failed (cargo exit code $LASTEXITCODE)"
    return
}

Write-Host '  [OK] executor installed'

#Requires -Version 7
# Install Review independently: Conductor v2 no longer links its implementation.
[CmdletBinding(SupportsShouldProcess)]
param([switch]$Force)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
    Write-Warning 'Cargo not found on PATH; skipping review-cli installation.'
    return
}
if (-not $Force -and (Get-Command review-cli -CommandType Application -ErrorAction SilentlyContinue)) {
    Write-Host '  [SKIP] review-cli already installed (use -Force to update)'
    return
}
if (-not $PSCmdlet.ShouldProcess('review-cli', 'Install Rust CLI from jared-two-foxes/review')) { return }
$argsForCargo = @('install', '--git', 'https://github.com/jared-two-foxes/review.git', '--locked', 'review-cli')
if ($Force) { $argsForCargo += '--force' }
& cargo @argsForCargo
if ($LASTEXITCODE -ne 0) {
    Write-Warning "review-cli installation failed (cargo exit code $LASTEXITCODE)"
    return
}
Write-Host '  [OK] review-cli installed'

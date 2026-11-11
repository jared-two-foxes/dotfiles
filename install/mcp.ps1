#Requires -Version 7
# Install the dependencies of the Pi delivery MCP server (pi/mcp).
# Only the manifest and lockfile are committed; `npm ci` downloads the exact locked versions.
[CmdletBinding(SupportsShouldProcess)]
param([switch]$Force)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Write-Warning 'npm not found on PATH; skipping MCP server dependency installation.'
    return
}
$server = Join-Path (Split-Path -Parent $PSScriptRoot) 'pi/mcp'
if (-not $Force -and (Test-Path (Join-Path $server 'node_modules/@modelcontextprotocol/sdk/package.json'))) {
    Write-Host '  [SKIP] MCP server dependencies already installed (use -Force to reinstall)'
    return
}
if (-not $PSCmdlet.ShouldProcess('pi/mcp', 'Install locked npm dependencies')) { return }
& npm ci --prefix $server --no-audit --no-fund
if ($LASTEXITCODE -ne 0) {
    Write-Warning "MCP server dependency installation failed (npm exit code $LASTEXITCODE)"
    return
}
Write-Host '  [OK] MCP server dependencies installed'

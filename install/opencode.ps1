#Requires -Version 7
# Shared deployment for the Windows installers and opencode/setup.ps1.
[CmdletBinding(SupportsShouldProcess)]
param(
    [ValidateSet('Link', 'Copy')]
    [string]$Mode = 'Link',
    [string]$ConfigDir = (Join-Path $env:USERPROFILE '.config/opencode'),
    [switch]$Force
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$SourceDir = Join-Path (Split-Path -Parent $PSScriptRoot) 'opencode'
$entries = @('agents', 'skills', 'scripts', 'tools', 'opencode.jsonc', 'dcp.jsonc')

function Test-DeploymentMatches {
    param([string]$Source, [string]$Destination)
    $item = Get-Item -LiteralPath $Destination -Force -ErrorAction SilentlyContinue
    if ($null -eq $item) { return $false }
    if ($Mode -eq 'Link') {
        if (-not $item.LinkType) { return $false }
        $target = @($item.Target)[0]
        return ([System.IO.Path]::GetFullPath($target) -eq [System.IO.Path]::GetFullPath($Source))
    }
    # Copy mode detaches existing links rather than writing through them.
    if ($item.LinkType) { return $false }
    if (Test-Path -LiteralPath $Source -PathType Container) {
        if (-not $item.PSIsContainer) { return $false }
        foreach ($file in Get-ChildItem -LiteralPath $Source -File -Recurse) {
            $relative = [System.IO.Path]::GetRelativePath($Source, $file.FullName)
            $copy = Join-Path $Destination $relative
            if (-not (Test-Path -LiteralPath $copy -PathType Leaf)) { return $false }
            if ((Get-FileHash -LiteralPath $file.FullName).Hash -ne (Get-FileHash -LiteralPath $copy).Hash) { return $false }
        }
        return $true
    }
    if ($item.PSIsContainer) { return $false }
    return ((Get-FileHash -LiteralPath $Source).Hash -eq (Get-FileHash -LiteralPath $Destination).Hash)
}

# Check all destinations before changing any; preserve unrelated configuration.
$conflicts = @()
foreach ($entry in $entries) {
    $source = Join-Path $SourceDir $entry
    if (-not (Test-Path -LiteralPath $source)) { throw "OpenCode source missing: $source" }
    $destination = Join-Path $ConfigDir $entry
    $existing = Get-Item -LiteralPath $destination -Force -ErrorAction SilentlyContinue
    if ($null -ne $existing -and -not (Test-DeploymentMatches $source $destination)) {
        $conflicts += $destination
    }
}
# Remove retired agents from copy installs as well as existing directory links.
# Back up each legacy file before replacing its old role with review-cli.
$retiredAgents = @('code-reviewer', 'security-reviewer', 'reuse-checker', 'refactorer', 'validator')
foreach ($agent in $retiredAgents) {
    $legacyAgent = Join-Path $ConfigDir "agents/$agent.md"
    if ($null -ne (Get-Item -LiteralPath $legacyAgent -Force -ErrorAction SilentlyContinue)) {
        # If the entire agents directory is already a conflict, backing it up covers this file.
        if ($conflicts -notcontains (Join-Path $ConfigDir 'agents')) { $conflicts += $legacyAgent }
    }
}
# A legacy JSON config would compete with the managed JSONC config.
$legacyConfig = Join-Path $ConfigDir 'opencode.json'
if ($null -ne (Get-Item -LiteralPath $legacyConfig -Force -ErrorAction SilentlyContinue)) {
    $conflicts += $legacyConfig
}
if ($conflicts.Count -gt 0 -and -not $Force) {
    Write-Warning "OpenCode configuration already exists. No OpenCode files changed. Re-run with -Force to back up and replace: $($conflicts -join ', ')"
    return
}
if (-not $PSCmdlet.ShouldProcess($ConfigDir, "Install OpenCode configuration using $Mode mode")) { return }
New-Item -ItemType Directory -Path $ConfigDir -Force | Out-Null
if ($conflicts.Count -gt 0) {
    $backupDir = Join-Path $ConfigDir ('backups/' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
    foreach ($path in $conflicts) {
        # Move the link itself; never recursively delete its target.
        Move-Item -LiteralPath $path -Destination (Join-Path $backupDir (Split-Path -Leaf $path))
    }
    Write-Host "OpenCode previous configuration backed up to $backupDir"
}
foreach ($entry in $entries) {
    $source = Join-Path $SourceDir $entry
    $destination = Join-Path $ConfigDir $entry
    if (Test-DeploymentMatches $source $destination) { continue }
    if ($Mode -eq 'Copy') {
        Copy-Item -LiteralPath $source -Destination $destination -Recurse -Force
    } else {
        $type = if ((Test-Path -LiteralPath $source -PathType Container) -and $IsWindows) { 'Junction' } else { 'SymbolicLink' }
        New-Item -ItemType $type -Path $destination -Target $source | Out-Null
    }
    Write-Host "OpenCode $entry installed ($Mode)"
}
# Latch state is local. Do not reset it on installer reruns.
$latch = Join-Path $ConfigDir 'latch.json'
if (-not (Test-Path -LiteralPath $latch)) {
    Copy-Item -LiteralPath (Join-Path $SourceDir 'latch.example.json') -Destination $latch
}
Write-Host 'Restart OpenCode to load the configuration.'

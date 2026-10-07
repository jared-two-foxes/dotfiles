#Requires -Version 7
# Run with pwsh -NoProfile -File tests/install-opencode.ps1.
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$installer = Join-Path $repo 'install/opencode.ps1'
$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('opencode-install-' + [guid]::NewGuid())
function Assert-True([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}
try {
    # Parse all shipped PowerShell, including both parent installers.
    foreach ($file in Get-ChildItem (Join-Path $repo 'install'), (Join-Path $repo 'opencode') -Filter '*.ps1' -Recurse) {
        $parseErrors = $null
        [System.Management.Automation.Language.Parser]::ParseFile($file.FullName, [ref]$null, [ref]$parseErrors) | Out-Null
        Assert-True ($parseErrors.Count -eq 0) "Parse failed: $($file.FullName): $parseErrors"
    }
    Get-Content (Join-Path $repo 'opencode/opencode.jsonc') -Raw | ConvertFrom-Json | Out-Null
    $config = Join-Path $tempRoot 'config'
    & $installer -Mode Copy -ConfigDir $config -WhatIf
    Assert-True (-not (Test-Path $config)) 'WhatIf created configuration'
    & $installer -Mode Copy -ConfigDir $config
    Assert-True ((Get-ChildItem (Join-Path $config 'agents') -File).Count -eq 12) 'Agent files missing'
    Assert-True (-not (Get-Item (Join-Path $config 'agents')).LinkType) 'Copy mode made a link'
    Assert-True (-not (Test-Path (Join-Path $config 'AGENTS.md'))) 'Repository instructions deployed globally'
    Set-Content (Join-Path $config 'latch.json') '{"state":"custom"}'
    Set-Content (Join-Path $config 'unrelated.txt') 'preserve'
    & $installer -Mode Copy -ConfigDir $config
    Assert-True (-not (Test-Path (Join-Path $config 'backups'))) 'Identical copy was not idempotent'
    Assert-True ((Get-Content (Join-Path $config 'latch.json') -Raw) -match 'custom') 'Rerun reset latch'
    Set-Content (Join-Path $config 'opencode.json') '{"legacy":true}'
    & $installer -Mode Link -ConfigDir $config
    Assert-True (Test-Path (Join-Path $config 'opencode.json')) 'Unforced install changed conflict'
    Assert-True (-not (Get-Item (Join-Path $config 'agents')).LinkType) 'Unforced install partially deployed'
    & $installer -Mode Link -ConfigDir $config -Force
    Assert-True (-not (Test-Path (Join-Path $config 'opencode.json'))) 'Legacy JSON competes with JSONC'
    Assert-True ([bool](Get-Item (Join-Path $config 'agents')).LinkType) 'Link mode failed'
    Assert-True ((Get-ChildItem (Join-Path $config 'backups') -Recurse -Filter opencode.json).Count -eq 1) 'Legacy config not backed up'
    $backups = @(Get-ChildItem (Join-Path $config 'backups')).Count
    & $installer -Mode Link -ConfigDir $config
    Assert-True (@(Get-ChildItem (Join-Path $config 'backups')).Count -eq $backups) 'Link rerun created backup'
    & $installer -Mode Copy -ConfigDir $config -Force
    Assert-True (-not (Get-Item (Join-Path $config 'agents')).LinkType) 'Copy mode did not detach link'
    Assert-True ((Get-Content (Join-Path $config 'unrelated.txt') -Raw).Trim() -eq 'preserve') 'Unrelated configuration changed'
    Assert-True (Test-Path (Join-Path $repo 'opencode/agents/build.md')) 'Source link target was damaged'
    & (Join-Path $repo 'opencode/setup.ps1') -Copy -ConfigDir (Join-Path $tempRoot 'standalone')
    Assert-True (Test-Path (Join-Path $tempRoot 'standalone/opencode.jsonc')) 'Setup wrapper failed'
    Write-Host 'OpenCode installer checks passed.'
} finally {
    # Detach backed-up links before recursively cleaning temporary files.
    if (Test-Path $tempRoot) {
        Get-ChildItem $tempRoot -Recurse -Force | Where-Object LinkType | ForEach-Object {
            Remove-Item -LiteralPath $_.FullName -Force
        }
        Remove-Item -LiteralPath $tempRoot -Recurse -Force
    }
}

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
    Assert-True ((Get-ChildItem (Join-Path $config 'agents') -File).Count -eq 7) 'Agent files missing'
    Assert-True (-not (Get-Item (Join-Path $config 'agents')).LinkType) 'Copy mode made a link'
    Assert-True (-not (Test-Path (Join-Path $config 'AGENTS.md'))) 'Repository instructions deployed globally'
    Set-Content (Join-Path $config 'latch.json') '{"state":"custom"}'
    Set-Content (Join-Path $config 'unrelated.txt') 'preserve'
    & $installer -Mode Copy -ConfigDir $config
    Assert-True (-not (Test-Path (Join-Path $config 'backups'))) 'Identical copy was not idempotent'
    Assert-True ((Get-Content (Join-Path $config 'latch.json') -Raw) -match 'custom') 'Rerun reset latch'
    Set-Content (Join-Path $config 'agents/validator.md') 'retired'
    Set-Content (Join-Path $config 'agents/daily-summary.md') 'retired summary'
    Set-Content (Join-Path $config 'scripts/run-daily-summary.ps1') 'retired launcher'
    Set-Content (Join-Path $config 'scripts/register-scheduled-task.ps1') 'retired registration'
    foreach ($skill in @('recallium', 'pipeline-completion-store')) {
        $legacySkill = Join-Path $config "skills/$skill"
        New-Item -ItemType Directory -Path $legacySkill | Out-Null
        Set-Content (Join-Path $legacySkill 'SKILL.md') "retired $skill"
    }
    # Retired agents, scripts and skills can remain in an otherwise current copy install.
    & $installer -Mode Copy -ConfigDir $config -Force
    Assert-True (-not (Test-Path (Join-Path $config 'agents/validator.md'))) 'Copy upgrade retained retired agent'
    Assert-True ((Get-ChildItem (Join-Path $config 'backups') -Recurse -Filter validator.md).Count -eq 1) 'Retired copy was not backed up'
    foreach ($legacy in @('agents/daily-summary.md', 'scripts/run-daily-summary.ps1', 'scripts/register-scheduled-task.ps1')) {
        Assert-True (-not (Test-Path (Join-Path $config $legacy))) "Retired daily-summary file survived: $legacy"
        Assert-True ((Get-ChildItem (Join-Path $config 'backups') -Recurse -Filter (Split-Path -Leaf $legacy)).Count -eq 1) "Retired daily-summary file was not backed up: $legacy"
    }
    foreach ($skill in @('recallium', 'pipeline-completion-store')) {
        Assert-True (-not (Test-Path (Join-Path $config "skills/$skill"))) "Retired memory skill survived: $skill"
        $backup = @(Get-ChildItem (Join-Path $config 'backups') -Recurse -Directory -Filter $skill)
        Assert-True ($backup.Count -eq 1) "Retired memory skill was not backed up: $skill"
        Assert-True ((Get-Content (Join-Path $backup[0].FullName 'SKILL.md') -Raw).Trim() -eq "retired $skill") "Retired skill backup changed: $skill"
    }
    Set-Content (Join-Path $config 'opencode.json') '{"legacy":true}'
    & $installer -Mode Link -ConfigDir $config
    Assert-True (Test-Path (Join-Path $config 'opencode.json')) 'Unforced install changed conflict'
    Assert-True (-not (Get-Item (Join-Path $config 'agents')).LinkType) 'Unforced install partially deployed'
    & $installer -Mode Link -ConfigDir $config -Force
    Assert-True (-not (Test-Path (Join-Path $config 'opencode.json'))) 'Legacy JSON competes with JSONC'
    Assert-True (-not (Test-Path (Join-Path $config 'agents/validator.md'))) 'Retired agent survived migration'
    Assert-True (Test-Path (Join-Path $config 'tools/review_changes.ts')) 'Review tool not deployed'
    Assert-True (Test-Path (Join-Path $config 'agents/review-phase.md')) 'Review phase agent not deployed'
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

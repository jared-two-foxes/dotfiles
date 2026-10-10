#Requires -Version 7
# Run with pwsh -NoProfile -File tests/install-conductor.ps1.
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$installer = Join-Path $repo 'install/conductor.ps1'

function Assert-True([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}

$parseErrors = $null
[System.Management.Automation.Language.Parser]::ParseFile($installer, [ref]$null, [ref]$parseErrors) | Out-Null
Assert-True ($parseErrors.Count -eq 0) "Installer parse failed: $parseErrors"

# Mock Cargo: no network or actual installation.
$global:ConductorMockCalls = @()
$global:ConductorMockExitCode = 0
function cargo {
    $global:ConductorMockCalls += ,@($args)
    $global:LASTEXITCODE = $global:ConductorMockExitCode
}

try {
    & $installer -Force -WhatIf
    Assert-True ($global:ConductorMockCalls.Count -eq 0) '-WhatIf invoked Cargo'

    & $installer -Force
    Assert-True ($global:ConductorMockCalls.Count -eq 1) 'Forced install did not invoke Cargo exactly once'
    $actual = $global:ConductorMockCalls[0] -join ' '
    Assert-True ($actual -eq 'install --git https://github.com/jared-two-foxes/conductor.git --force') "Unexpected Cargo arguments: $actual"

    $global:ConductorMockExitCode = 42
    & $installer -Force
    Assert-True ($global:ConductorMockCalls.Count -eq 2) 'Failed install did not invoke Cargo'

    foreach ($parent in @('windows-full.ps1', 'windows-restricted.ps1')) {
        $source = Get-Content (Join-Path $repo "install/$parent") -Raw
        Assert-True ($source.Contains("conductor.ps1') -Force:$Force -WhatIf:$WhatIfPreference")) "$parent does not forward Conductor installer flags"
    }
    Write-Host 'conductor installer checks passed.'
} finally {
    Remove-Item Function:cargo -ErrorAction SilentlyContinue
    Remove-Variable ConductorMockCalls, ConductorMockExitCode -Scope Global -ErrorAction SilentlyContinue
}

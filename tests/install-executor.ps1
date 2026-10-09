#Requires -Version 7
# Run with pwsh -NoProfile -File tests/install-executor.ps1.
$ErrorActionPreference = 'Stop'
$installer = Join-Path (Split-Path -Parent $PSScriptRoot) 'install/executor.ps1'

function Assert-True([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}

$parseErrors = $null
[System.Management.Automation.Language.Parser]::ParseFile($installer, [ref]$null, [ref]$parseErrors) | Out-Null
Assert-True ($parseErrors.Count -eq 0) "Installer parse failed: $parseErrors"

# Mock Cargo so the test never downloads or installs software.
$global:ExecutorMockCalls = @()
$global:ExecutorMockExitCode = 0
function cargo {
    $global:ExecutorMockCalls += ,@($args)
    $global:LASTEXITCODE = $global:ExecutorMockExitCode
}

try {
    & $installer -Force -WhatIf
    Assert-True ($global:ExecutorMockCalls.Count -eq 0) '-WhatIf invoked Cargo'

    & $installer -Force
    Assert-True ($global:ExecutorMockCalls.Count -eq 1) 'Forced install did not invoke Cargo exactly once'
    $actual = $global:ExecutorMockCalls[0] -join ' '
    Assert-True ($actual -eq 'install --git https://github.com/jared-two-foxes/executor.git --locked --force') "Unexpected Cargo arguments: $actual"

    $global:ExecutorMockExitCode = 42
    & $installer -Force -WarningVariable warnings
    Assert-True ($global:ExecutorMockCalls.Count -eq 2) 'Failed install did not invoke Cargo'
    Assert-True (@($warnings).Count -gt 0) 'Failed Cargo install did not warn'

    foreach ($parent in @('windows-full.ps1', 'windows-restricted.ps1')) {
        $source = Get-Content (Join-Path (Split-Path -Parent $installer) $parent) -Raw
        Assert-True ($source.Contains("'executor.ps1') -Force:\$Force -WhatIf:\$WhatIfPreference")) "$parent does not forward installer flags"
    }
    Write-Host 'executor installer checks passed.'
} finally {
    Remove-Item Function:cargo -ErrorAction SilentlyContinue
    Remove-Variable ExecutorMockCalls, ExecutorMockExitCode -Scope Global -ErrorAction SilentlyContinue
}

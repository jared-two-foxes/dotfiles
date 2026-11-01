#Requires -Version 7
# Run with pwsh -NoProfile -File tests/install-review.ps1.
$ErrorActionPreference = 'Stop'
$installer = Join-Path (Split-Path -Parent $PSScriptRoot) 'install/review.ps1'

function Assert-True([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}

$parseErrors = $null
[System.Management.Automation.Language.Parser]::ParseFile($installer, [ref]$null, [ref]$parseErrors) | Out-Null
Assert-True ($parseErrors.Count -eq 0) "Installer parse failed: $parseErrors"

# Mock Cargo so the test never downloads or installs software.
$global:ReviewMockCalls = @()
$global:ReviewMockExitCode = 0
function cargo {
    $global:ReviewMockCalls += ,@($args)
    $global:LASTEXITCODE = $global:ReviewMockExitCode
}

try {
    & $installer -Force -WhatIf
    Assert-True ($global:ReviewMockCalls.Count -eq 0) '-WhatIf invoked Cargo'

    & $installer -Force
    Assert-True ($global:ReviewMockCalls.Count -eq 1) 'Forced install did not invoke Cargo exactly once'
    $actual = $global:ReviewMockCalls[0] -join ' '
    Assert-True ($actual -eq 'install --git https://github.com/jared-two-foxes/review.git --locked review-cli --force') "Unexpected Cargo arguments: $actual"

    $global:ReviewMockExitCode = 42
    & $installer -Force
    Assert-True ($global:ReviewMockCalls.Count -eq 2) 'Failed install did not invoke Cargo'

    foreach ($parent in @('windows-full.ps1', 'windows-restricted.ps1')) {
        $source = Get-Content (Join-Path (Split-Path -Parent $installer) $parent) -Raw
        Assert-True ($source.Contains('-Force:$Force -WhatIf:$WhatIfPreference')) "$parent does not forward installer flags"
    }
    Write-Host 'review installer checks passed.'
} finally {
    $global:LASTEXITCODE = 0
    Remove-Item Function:cargo -ErrorAction SilentlyContinue
    Remove-Variable ReviewMockCalls, ReviewMockExitCode -Scope Global -ErrorAction SilentlyContinue
}

#Requires -Version 7
# Run with pwsh -NoProfile -File tests/install-mcp.ps1.
$ErrorActionPreference = 'Stop'
$installer = Join-Path (Split-Path -Parent $PSScriptRoot) 'install/mcp.ps1'

function Assert-True([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}

$parseErrors = $null
[System.Management.Automation.Language.Parser]::ParseFile($installer, [ref]$null, [ref]$parseErrors) | Out-Null
Assert-True ($parseErrors.Count -eq 0) "Installer parse failed: $parseErrors"

# Mock npm so the test never downloads or installs software.
$global:McpMockCalls = @()
$global:McpMockExitCode = 0
function npm {
    $global:McpMockCalls += ,@($args)
    $global:LASTEXITCODE = $global:McpMockExitCode
}

try {
    & $installer -Force -WhatIf
    Assert-True ($global:McpMockCalls.Count -eq 0) '-WhatIf invoked npm'

    & $installer -Force
    Assert-True ($global:McpMockCalls.Count -eq 1) 'Forced install did not invoke npm exactly once'
    $server = Join-Path (Split-Path -Parent $PSScriptRoot) 'pi/mcp'
    $actual = $global:McpMockCalls[0] -join ' '
    Assert-True ($actual -eq "ci --prefix $server --no-audit --no-fund") "Unexpected npm arguments: $actual"

    $global:McpMockExitCode = 42
    & $installer -Force
    Assert-True ($global:McpMockCalls.Count -eq 2) 'Failed install did not invoke npm'

    foreach ($parent in @('windows-full.ps1', 'windows-restricted.ps1')) {
        $source = Get-Content (Join-Path (Split-Path -Parent $installer) $parent) -Raw
        Assert-True ($source.Contains("'mcp.ps1') -Force:`$Force -WhatIf:`$WhatIfPreference")) "$parent does not run the MCP installer with forwarded flags"
    }
    Write-Host 'mcp installer checks passed.'
} finally {
    $global:LASTEXITCODE = 0
    Remove-Item Function:npm -ErrorAction SilentlyContinue
    Remove-Variable McpMockCalls, McpMockExitCode -Scope Global -ErrorAction SilentlyContinue
}

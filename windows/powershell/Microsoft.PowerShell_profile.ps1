# =============================================================
# Microsoft.PowerShell_profile.ps1 — Entry point
# Dot-sources all modules from the same directory.
# =============================================================

$ProfileDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ModulesDir  = Join-Path $ProfileDir 'modules'

# Load modules in order
foreach ($module in @('env', 'aliases', 'functions', 'prompt')) {
    $path = Join-Path $ModulesDir "$module.ps1"
    if (Test-Path $path) {
        . $path
    }
}

# Load machine-local overrides last (gitignored, never tracked)
$localProfile = Join-Path $ProfileDir 'profile.local.ps1'
if (Test-Path $localProfile) {
    . $localProfile
}

# register-scheduled-task.ps1
# One-time setup: registers the "OpenCode Daily Summary" Windows Scheduled Task.
# Re-run with -Time "HH:mm" to change the scheduled time.
# Idempotent: uses -Force to replace any existing registration.

param(
    [string]$Time = "23:59"
)

$taskName  = "OpenCode Daily Summary"
$scriptPath = Join-Path $PSScriptRoot "run-daily-summary.ps1"

# ---------------------------------------------------------------------------
# Task action
# ---------------------------------------------------------------------------
$action = New-ScheduledTaskAction `
    -Execute  "pwsh.exe" `
    -Argument "-NonInteractive -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$scriptPath`""

# ---------------------------------------------------------------------------
# Trigger: daily at $Time
# ---------------------------------------------------------------------------
$trigger = New-ScheduledTaskTrigger -Daily -At $Time

# ---------------------------------------------------------------------------
# Principal: current interactive user, limited run level
# ---------------------------------------------------------------------------
$principal = New-ScheduledTaskPrincipal `
    -UserId    "$env:USERDOMAIN\$env:USERNAME" `
    -LogonType Interactive `
    -RunLevel  Limited

# ---------------------------------------------------------------------------
# Settings: 1-hour execution limit, ignore new instances if already running
# ---------------------------------------------------------------------------
$settings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit (New-TimeSpan -Hours 1) `
    -MultipleInstances  IgnoreNew

# ---------------------------------------------------------------------------
# Register (idempotent via -Force)
# ---------------------------------------------------------------------------
Register-ScheduledTask `
    -TaskName $taskName `
    -Action   $action `
    -Trigger  $trigger `
    -Principal $principal `
    -Settings  $settings `
    -Force | Out-Null

# ---------------------------------------------------------------------------
# Confirmation output
# ---------------------------------------------------------------------------
$displayTime = ([datetime]::ParseExact($Time, 'HH:mm', $null)).ToString('HH:mm')
Write-Host "Task '$taskName' registered to run daily at $displayTime."
Write-Host ""
Write-Host "To verify:"
Write-Host "  Get-ScheduledTask -TaskName '$taskName' | Format-List"
Write-Host ""
Write-Host "To test-fire immediately:"
Write-Host "  Start-ScheduledTask -TaskName '$taskName'"
Write-Host ""
Write-Host "Log location: $env:USERPROFILE\.config\opencode\logs\"

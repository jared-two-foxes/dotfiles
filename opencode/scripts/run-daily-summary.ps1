# run-daily-summary.ps1
# Nightly launcher for the OpenCode daily-summary agent.
# Invoked by Windows Task Scheduler. Logs all output to a dated log file.

$ErrorActionPreference = 'Continue'

# ---------------------------------------------------------------------------
# Log setup
# ---------------------------------------------------------------------------
$logDir  = Join-Path $env:USERPROFILE '.config\opencode\logs'
New-Item -ItemType Directory -Path $logDir -Force | Out-Null

$logDate = Get-Date -Format 'yyyy-MM-dd'
$logFile = Join-Path $logDir "daily-summary-$logDate.log"

function Write-Log {
    param([string]$Message)
    $ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    $line = "[$ts] $Message"
    Write-Output $line
    Add-Content -Path $logFile -Value $line
}

Write-Log "=== daily-summary run started ==="

# ---------------------------------------------------------------------------
# Pre-flight: TCP check for Recallium on localhost:8001
# ---------------------------------------------------------------------------
Write-Log "Pre-flight: checking Recallium TCP connection on localhost:8001 ..."
try {
    $tcpClient = New-Object System.Net.Sockets.TcpClient
    $connectResult = $tcpClient.BeginConnect('localhost', 8001, $null, $null)
    $waited = $connectResult.AsyncWaitHandle.WaitOne(3000)   # 3-second timeout
    if ($waited -and $tcpClient.Connected) {
        $tcpClient.EndConnect($connectResult)
        Write-Log "Pre-flight OK: Recallium is reachable on localhost:8001."
    } else {
        Write-Log "WARNING: Recallium is NOT reachable on localhost:8001. The daily-summary agent will run without memory context."
    }
    $tcpClient.Close()
} catch {
    Write-Log "WARNING: TCP pre-flight check threw an exception: $_. Continuing anyway."
}

# ---------------------------------------------------------------------------
# Run the daily-summary agent
# ---------------------------------------------------------------------------
Write-Log "Launching: opencode run `"daily summary`" --agent daily-summary"

$output = & opencode run "daily summary" --agent daily-summary 2>&1
$exitCode = $LASTEXITCODE

# Write captured output into the log file
if ($output) {
    foreach ($line in $output) {
        Add-Content -Path $logFile -Value $line
    }
}

Write-Log "opencode exited with code: $exitCode"
Write-Log "=== daily-summary run finished ==="

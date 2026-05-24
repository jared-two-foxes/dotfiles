# =============================================================
# modules/prompt.ps1 — Prompt configuration
#
# Priority:
#   1. Starship (if found on PATH or in ~/bin)
#   2. Pure PowerShell fallback prompt
# =============================================================

function _Find-Starship {
    # Check PATH first
    $cmd = Get-Command starship -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }

    # Check ~/bin (common drop location on restricted machines)
    $local = Join-Path $env:USERPROFILE 'bin\starship.exe'
    if (Test-Path $local) { return $local }

    return $null
}

$_starshipPath = _Find-Starship

if ($_starshipPath) {
    # ---- Starship prompt ------------------------------------
    $env:STARSHIP_SHELL = 'powershell'

    # Point to our shared starship config
    $starshipConfig = Join-Path $PSScriptRoot '..\..\..\..\shared\starship\starship.toml' |
        Resolve-Path -ErrorAction SilentlyContinue
    if ($starshipConfig) {
        $env:STARSHIP_CONFIG = $starshipConfig.Path
    }

    Invoke-Expression (& $_starshipPath init powershell --print-full-init | Out-String)

} else {
    # ---- Pure PowerShell fallback ---------------------------
    # Shows: [user@host] cwd [branch±] ❯
    function global:prompt {
        $lastOk  = $?
        $reset   = "`e[0m"
        $bold    = "`e[1m"
        $cyan    = "`e[36m"
        $purple  = "`e[35m"
        $yellow  = "`e[33m"
        $green   = "`e[32m"
        $red     = "`e[31m"

        # Current directory — shorten home to ~
        $cwd = $PWD.Path -replace [regex]::Escape($env:USERPROFILE), '~'

        # Git branch + dirty indicator
        $gitPart = ''
        if (Get-Command git -ErrorAction SilentlyContinue) {
            $branch = git rev-parse --abbrev-ref HEAD 2>$null
            if ($branch) {
                $dirty = if (git status --porcelain 2>$null) { '*' } else { '' }
                $gitPart = " ${purple}${bold}${branch}${dirty}${reset}"
            }
        }

        # Prompt character colour based on last exit code
        $charColor = if ($lastOk) { $green } else { $red }

        "${bold}${cyan}${cwd}${reset}${gitPart}`n${charColor}${bold}❯${reset} "
    }
}

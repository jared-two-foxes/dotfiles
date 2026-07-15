# pi-docker.ps1 — Run pi in Docker with default system prompt, scoped to cwd

$repoRoot   = Join-Path $HOME "code/tooling/dotfiles"
$composeFile = Join-Path $repoRoot "docker/pi/compose.yaml"
$envFile     = Join-Path $repoRoot "docker/pi/.env"

$env:WORKSPACE = (Get-Location).Path
$env:CONTAINER_WORKDIR = "/scratch/" + (Get-Item (Get-Location)).Name

# --- Image selection -----------------------------------------------------
# Picks which Docker image pi runs in, so each project gets only the
# toolchain it needs (rust / typescript / python) instead of one
# bloated image holding everything. See docker-pi-profiles-plan.md.
#
# Precedence (first match wins):
#   1. .pi/Dockerfile in cwd       -> build & use that (full custom image)
#   2. .pi/profile in cwd          -> use the named profile
#   3. marker-file auto-detect     -> Cargo.toml/package.json/pyproject.toml ...
#   4. fallback                    -> pi-base:local (today's behaviour)
#
# Profiles are built `FROM pi-base:local`, so the base is always built
# first (docker layer cache makes a no-op build ~1s; correctness over
# cleverness — no hash/mtime tracking to go stale).

$knownProfiles = @('rust', 'typescript', 'python')

$buildBase = {  # scriptblock: always (re)build base; cache makes it cheap
    & docker build -t pi-base:local (Join-Path $repoRoot 'docker/pi') | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "base image build failed" }
}

$workspace = (Get-Location).Path
$imageTag  = $null   # set to the final pi-<tag>:local to run

# 1. Per-project .pi/Dockerfile (escape hatch for polyglot / custom env).
$projectDockerfile = Join-Path $workspace '.pi/Dockerfile'
if (Test-Path $projectDockerfile) {
    # Sanitize cwd name -> safe image tag (lower-case, non-alnum -> '-').
    $slug = (Get-Item $workspace).Name.ToLower() -replace '[^a-z0-9]+', '-'
    $slug = $slug.Trim('-')
    if (-not $slug) { $slug = 'project' }
    & $buildBase
    $imageTag = "pi-project-$slug:local"
    & docker build -t $imageTag -f $projectDockerfile $workspace | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "per-project image build failed ($imageTag)" }
}

# 2. .pi/profile (one-line: rust | typescript | python).
if (-not $imageTag -and (Test-Path (Join-Path $workspace '.pi/profile'))) {
    $named = $null
    foreach ($line in Get-Content (Join-Path $workspace '.pi/profile')) {
        $t = $line.Trim()
        if (-not $t -or $t.StartsWith('#')) { continue }
        $named = $t; break
    }
    if ($named) {
        if ($named -notin $knownProfiles) {
            Write-Warning "ignoring unknown .pi/profile value '$named'; falling back to auto-detect"
        } else {
            & $buildBase
            $imageTag = "pi-$named:local"
            & docker build -t $imageTag (Join-Path $repoRoot "docker/pi/profiles/$named") | Out-Null
            if ($LASTEXITCODE -ne 0) { throw "profile image build failed ($imageTag)" }
        }
    }
}

# 3. Marker-file auto-detect (mirrors ticket-pipeline's toolchains.py
#    priority, minus bazel/cmake which have no profile yet).
if (-not $imageTag) {
    $detected = $null
    if (Test-Path (Join-Path $workspace 'Cargo.toml')) {
        $detected = 'rust'
    } elseif ((Test-Path (Join-Path $workspace 'svelte.config.js')) -or `
              (Test-Path (Join-Path $workspace 'svelte.config.ts')) -or `
              (Test-Path (Join-Path $workspace 'package.json'))) {
        $detected = 'typescript'
    } elseif ((Test-Path (Join-Path $workspace 'pyproject.toml')) -or `
              (Test-Path (Join-Path $workspace 'setup.py')) -or `
              (Test-Path (Join-Path $workspace 'requirements.txt'))) {
        $detected = 'python'
    }
    if ($detected) {
        & $buildBase
        $imageTag = "pi-$detected:local"
        & docker build -t $imageTag (Join-Path $repoRoot "docker/pi/profiles/$detected") | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "profile image build failed ($imageTag)" }
    }
}

# 4. Fallback: bare base (today's behaviour). Always built here too so a
#    manual `docker compose run` afterwards finds the tag.
if (-not $imageTag) {
    & $buildBase
    $imageTag = 'pi-base:local'
}

$env:PI_IMAGE = $imageTag

# --- pi flags (passed after the service name) ---
$piArgs = @()

# If a plan file exists in cwd, point pi at it.
$planFile = Join-Path (Get-Location).Path ".pi\plan.md"
if (Test-Path $planFile) {
    $piArgs += @("--append-system-prompt", "$env:CONTAINER_WORKDIR/.pi/plan.md")
}

# --- compose-run options (passed before the service name) ---
$composeRunOpts = @()

# Mount the Linear extension only when a non-empty LINEAR_API_KEY is
# present in .env. That makes linear_get_ticket / linear_update_ticket
# available exactly when they can authenticate, and absent otherwise —
# the plan extension (write_plan) is never mounted here.
#
# .env values are read directly (not via the shell environment) so the
# decision matches what the container will actually receive through
# env_file. A blank value (LINEAR_API_KEY=) or a commented-out line
# counts as absent, matching the extension's own getApiKey() check.
$linearKey = $null
if (Test-Path $envFile) {
    foreach ($line in Get-Content $envFile) {
        $t = $line.Trim()
        if (-not $t -or $t.StartsWith("#")) { continue }
        $idx = $t.IndexOf("=")
        if ($idx -lt 0) { continue }
        $name = $t.Substring(0, $idx).Trim()
        if ($name -eq "LINEAR_API_KEY") {
            $val = $t.Substring($idx + 1).Trim()
            if ($val) { $linearKey = $val }
            break
        }
    }
}
if ($linearKey) {
    # docker compose run resolves -v host paths relative to cwd, not the
    # compose file, so use an absolute path. Forward slashes keep it
    # unambiguous on Windows (drive-letter colon + Docker Desktop).
    $linearExt = (Join-Path $repoRoot "pi/agent/extensions/linear") -replace '\\', '/'
    $composeRunOpts += @("-v", "${linearExt}:/root/.pi/agent/extensions/linear:ro")
}

# Example:
#   pi-docker.ps1 --provider anthropic --model claude-sonnet-4 "refactor this function"
# Or just:
#   pi-docker.ps1 "help me debug this"
# (uses whatever default model pi picks based on available API keys)

docker compose `
    -f "$composeFile" `
    run --rm @composeRunOpts pi --no-context-files @piArgs @args

exit $LASTEXITCODE
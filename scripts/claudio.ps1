#Requires -Version 5.1
<#
.SYNOPSIS
    Run Claude Code through the local LiteLLM proxy backed by GitHub Copilot.

.DESCRIPTION
    Sets the Anthropic-compatible env vars Claude Code reads, then invokes
    `claude` with whatever arguments you pass through. Reads the LiteLLM
    master key (which doubles as the proxy's auth token) from
    %USERPROFILE%\.claudio\config.json, written by setup.ps1.

.EXAMPLE
    claudio
    claudio --print "what does this repo do"
#>

$ErrorActionPreference = 'Stop'

$configPath = Join-Path $env:USERPROFILE '.claudio\config.json'
if (-not (Test-Path -LiteralPath $configPath)) {
    Write-Error "claudio isn't configured yet. Run scripts/setup.ps1 from the claudio repo first."
    exit 1
}

$config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
if (-not $config.master_key) {
    Write-Error "Config at $configPath is missing 'master_key'. Re-run scripts/setup.ps1."
    exit 1
}

# Smoke-test the proxy before handing control to claude. A clear error here
# beats a confusing one from inside the harness.
try {
    $null = Invoke-WebRequest -Uri 'http://127.0.0.1:4000/health/liveliness' `
        -Method Get -TimeoutSec 2 -UseBasicParsing -ErrorAction Stop
} catch {
    Write-Error @"
LiteLLM proxy is not reachable at http://127.0.0.1:4000.
Start the container:    podman compose up -d   (or docker compose up -d)
Open the control panel: http://localhost:3000
"@
    exit 1
}

$env:ANTHROPIC_BASE_URL  = 'http://127.0.0.1:4000'
$env:ANTHROPIC_AUTH_TOKEN = $config.master_key

# Defaults used when the webapp is unreachable or hasn't been told otherwise.
# These match the hardcoded values from before /api/preferences existed.
$opusDefault   = 'claude-opus-4-7'
$sonnetDefault = 'claude-sonnet-4-6'
$haikuDefault  = 'claude-haiku-4-5'

# Pull per-tier defaults from the webapp. The user picks them in /; the
# webapp persists them on the claudio_app named volume. Soft-fail to the
# hardcoded values if the webapp can't be reached so the wrapper still
# works headless (boot-time, network blip, podman not started yet).
try {
    $prefs = Invoke-RestMethod -Uri 'http://127.0.0.1:3000/api/preferences' `
        -Method Get -TimeoutSec 2 -UseBasicParsing -ErrorAction Stop
    if ($prefs.opus)   { $opusDefault   = $prefs.opus }
    if ($prefs.sonnet) { $sonnetDefault = $prefs.sonnet }
    if ($prefs.haiku)  { $haikuDefault  = $prefs.haiku }
} catch {
    # silent fallback; not worth a warning for a transient network issue
}

# Pin alias resolution to the IDs the gateway actually serves. Without this
# `/model sonnet` could resolve to an ID the gateway doesn't recognise.
$env:ANTHROPIC_DEFAULT_OPUS_MODEL   = $opusDefault
$env:ANTHROPIC_DEFAULT_SONNET_MODEL = $sonnetDefault
$env:ANTHROPIC_DEFAULT_HAIKU_MODEL  = $haikuDefault

# claude is in PATH already (Claude Code installs itself globally). Pass
# through every argument verbatim so flags like --print or --model work.
& claude @args
exit $LASTEXITCODE

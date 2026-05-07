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

# PowerShell scoping rule: $env:VAR writes go to the actual process
# environment block, ignoring script scope. If this script runs in-process
# (which it does when `claudio` resolves to claudio.ps1 rather than
# claudio.cmd), assignments below would leak into the caller's shell — a
# later plain `claude` in the same session would silently route through
# our proxy and burn the user's Copilot quota. Snapshot first, restore in
# a `finally` so the script is invocation-safe regardless of how PATH
# resolution lands.
$envNames = @(
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_DEFAULT_OPUS_MODEL',
    'ANTHROPIC_DEFAULT_SONNET_MODEL',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL'
)
$envSnapshot = @{}
foreach ($name in $envNames) {
    $envSnapshot[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}

# Heartbeat to the webapp so the dashboard can show "claudio running" while
# this script is alive. Soft-fails if the webapp is down — main flow already
# smoke-tested LiteLLM, which is what actually matters.
$sessionId = [guid]::NewGuid().ToString()
$webappBase = 'http://127.0.0.1:3000'
$heartbeatJob = $null
try {
    $null = Invoke-RestMethod -Uri "$webappBase/api/session/heartbeat" `
        -Method Post -TimeoutSec 2 -ContentType 'application/json' `
        -Body (ConvertTo-Json @{ id = $sessionId }) -ErrorAction Stop
    $heartbeatJob = Start-Job -ScriptBlock {
        param($id, $base)
        while ($true) {
            Start-Sleep -Seconds 10
            try {
                Invoke-RestMethod -Uri "$base/api/session/heartbeat" `
                    -Method Post -TimeoutSec 2 -ContentType 'application/json' `
                    -Body (ConvertTo-Json @{ id = $id }) -ErrorAction Stop | Out-Null
            } catch {}
        }
    } -ArgumentList $sessionId, $webappBase
} catch {
    # webapp unreachable; dashboard just won't show this session
}

$exitCode = 0
try {
    $env:ANTHROPIC_BASE_URL  = 'http://127.0.0.1:4000'
    $env:ANTHROPIC_AUTH_TOKEN = $config.master_key
    # Pin alias resolution to the IDs the gateway actually serves. Without this
    # `/model sonnet` could resolve to an ID the gateway doesn't recognise.
    $env:ANTHROPIC_DEFAULT_OPUS_MODEL   = $opusDefault
    $env:ANTHROPIC_DEFAULT_SONNET_MODEL = $sonnetDefault
    $env:ANTHROPIC_DEFAULT_HAIKU_MODEL  = $haikuDefault

    # claude is in PATH already (Claude Code installs itself globally). Pass
    # through every argument verbatim so flags like --print or --model work.
    & claude @args
    $exitCode = $LASTEXITCODE
} finally {
    # Runs on normal exit, exception, and Ctrl+C. SetEnvironmentVariable with
    # a $null value removes the variable cleanly (unlike `$env:X = $null`,
    # which leaves an empty-string entry behind).
    foreach ($name in $envNames) {
        [Environment]::SetEnvironmentVariable($name, $envSnapshot[$name], 'Process')
    }
    if ($heartbeatJob) {
        Stop-Job   -Job $heartbeatJob -ErrorAction SilentlyContinue
        Remove-Job -Job $heartbeatJob -Force -ErrorAction SilentlyContinue
    }
    try {
        $null = Invoke-RestMethod -Uri "$webappBase/api/session/end" `
            -Method Post -TimeoutSec 1 -ContentType 'application/json' `
            -Body (ConvertTo-Json @{ id = $sessionId }) -ErrorAction Stop
    } catch {
        # session will age out from the webapp's heartbeat map within ~30s anyway
    }
}
exit $exitCode

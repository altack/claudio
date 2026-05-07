#Requires -Version 5.1
<#
.SYNOPSIS
    One-shot setup for claudio on Windows.

.DESCRIPTION
    1. Detects podman (preferred) or docker.
    2. Verifies .env exists and has LITELLM_MASTER_KEY set.
    3. Builds and starts the container.
    4. Installs the claudio wrapper into ~\.claude\bin and adds it to PATH.
    5. Opens the control panel in your default browser.

    Re-running is safe; everything is idempotent.
#>

[CmdletBinding()]
param(
    [switch]$SkipBrowser
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $repoRoot

function Resolve-ContainerCli {
    $podman = Get-Command podman -ErrorAction SilentlyContinue
    if ($podman) {
        $compose = & podman compose version 2>$null
        if ($LASTEXITCODE -eq 0) { return @{ Cli = 'podman'; Compose = @('podman','compose') } }
        # Some installs only ship podman-compose.
        if (Get-Command podman-compose -ErrorAction SilentlyContinue) {
            return @{ Cli = 'podman'; Compose = @('podman-compose') }
        }
        Write-Warning "Found podman but no compose support. Install Podman Desktop or 'pip install podman-compose'."
    }
    $docker = Get-Command docker -ErrorAction SilentlyContinue
    if ($docker) {
        & docker compose version *> $null
        if ($LASTEXITCODE -eq 0) { return @{ Cli = 'docker'; Compose = @('docker','compose') } }
    }
    throw "Neither podman nor docker with compose support is installed. Install Podman Desktop (preferred) or Docker Desktop."
}

function Read-DotEnv {
    param([string]$Path)
    $result = @{}
    if (-not (Test-Path -LiteralPath $Path)) { return $result }
    foreach ($line in Get-Content -LiteralPath $Path) {
        if ($line -match '^\s*#') { continue }
        if ($line -match '^\s*$') { continue }
        if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$') {
            $result[$matches[1]] = $matches[2].Trim('"').Trim("'")
        }
    }
    return $result
}

# --- 1. Container CLI ---------------------------------------------------------
Write-Host "[1/5] Detecting container CLI..." -ForegroundColor Cyan
$cli = Resolve-ContainerCli
Write-Host "      using: $($cli.Compose -join ' ')" -ForegroundColor DarkGray

function New-MasterKey {
    # 24 random bytes -> 48 hex chars. Hex (vs base64) avoids the variable
    # length you get after stripping +/= from base64 output.
    $bytes = New-Object byte[] 24
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    return 'sk-claudio-' + ([System.BitConverter]::ToString($bytes) -replace '-','').ToLower()
}

# --- 2. .env ------------------------------------------------------------------
Write-Host "[2/5] Checking .env..." -ForegroundColor Cyan
$envFile = Join-Path $repoRoot '.env'
if (-not (Test-Path -LiteralPath $envFile)) {
    Copy-Item -LiteralPath (Join-Path $repoRoot '.env.example') -Destination $envFile
    Write-Host "      created .env from .env.example" -ForegroundColor DarkGray
}
$envVars = Read-DotEnv -Path $envFile
if (-not $envVars['LITELLM_MASTER_KEY'] -or $envVars['LITELLM_MASTER_KEY'] -eq 'sk-claudio-change-me') {
    $randomKey = New-MasterKey
    if (Select-String -LiteralPath $envFile -Pattern '^LITELLM_MASTER_KEY=' -Quiet) {
        (Get-Content -LiteralPath $envFile) `
            -replace '^LITELLM_MASTER_KEY=.*', "LITELLM_MASTER_KEY=$randomKey" |
            Set-Content -LiteralPath $envFile -Encoding UTF8
    } else {
        Add-Content -LiteralPath $envFile -Value "LITELLM_MASTER_KEY=$randomKey" -Encoding UTF8
    }
    $envVars['LITELLM_MASTER_KEY'] = $randomKey
    Write-Host "      minted a random LITELLM_MASTER_KEY in .env" -ForegroundColor DarkGray
}
$masterKey = $envVars['LITELLM_MASTER_KEY']

# --- 3. Build & start ---------------------------------------------------------
Write-Host "[3/5] Building image (first time can take a few minutes)..." -ForegroundColor Cyan
& $cli.Compose[0] @($cli.Compose[1..($cli.Compose.Length-1)] + @('build'))
if ($LASTEXITCODE -ne 0) { throw "compose build failed." }

Write-Host "[4/5] Starting container..." -ForegroundColor Cyan
& $cli.Compose[0] @($cli.Compose[1..($cli.Compose.Length-1)] + @('up','-d'))
if ($LASTEXITCODE -ne 0) { throw "compose up failed." }

# --- 4. Wrapper ---------------------------------------------------------------
Write-Host "[5/5] Installing claudio wrapper..." -ForegroundColor Cyan
& (Join-Path $PSScriptRoot 'install-claudio.ps1') -MasterKey $masterKey

# --- 5. Hand-off --------------------------------------------------------------
Write-Host ""
Write-Host "claudio is up." -ForegroundColor Green
Write-Host "  Control panel: http://localhost:3000"
Write-Host "  Proxy:         http://127.0.0.1:4000"
Write-Host ""
Write-Host "Next: open the control panel and click 'Sign in with GitHub' on /auth."
Write-Host "      Then run 'claudio' from a fresh terminal."

if (-not $SkipBrowser) {
    Start-Process 'http://localhost:3000'
}

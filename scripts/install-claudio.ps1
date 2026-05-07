#Requires -Version 5.1
<#
.SYNOPSIS
    Install the claudio wrapper into ~\.claude\bin and persist its master key.

.DESCRIPTION
    Called by setup.ps1, but also runnable on its own if you only want to
    refresh the wrapper after pulling repo changes. Idempotent.

.PARAMETER MasterKey
    The LITELLM_MASTER_KEY value. The wrapper sends it as ANTHROPIC_AUTH_TOKEN.
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$MasterKey
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$srcPs1   = Join-Path $repoRoot 'scripts\claudio.ps1'
$srcCmd   = Join-Path $repoRoot 'scripts\claudio.cmd'

$binDir   = Join-Path $env:USERPROFILE '.claude\bin'
$cfgDir   = Join-Path $env:USERPROFILE '.claudio'
$cfgPath  = Join-Path $cfgDir 'config.json'

# 1. Drop the wrapper into ~\.claude\bin.
if (-not (Test-Path -LiteralPath $binDir)) {
    New-Item -ItemType Directory -Path $binDir -Force | Out-Null
}
Copy-Item -LiteralPath $srcPs1 -Destination (Join-Path $binDir 'claudio.ps1') -Force
Copy-Item -LiteralPath $srcCmd -Destination (Join-Path $binDir 'claudio.cmd') -Force
Write-Host "[claudio] wrapper installed -> $binDir" -ForegroundColor Green

# 2. Persist the master key (only stored on this machine, mode 600-ish).
if (-not (Test-Path -LiteralPath $cfgDir)) {
    New-Item -ItemType Directory -Path $cfgDir -Force | Out-Null
}
@{ master_key = $MasterKey } |
    ConvertTo-Json |
    Set-Content -LiteralPath $cfgPath -Encoding UTF8
# %USERPROFILE% inherits user-only ACLs by default; no extra hardening
# needed for a local-only secret on a single-user box.
Write-Host "[claudio] master key written -> $cfgPath" -ForegroundColor Green

# 3. Make sure ~\.claude\bin is on the user PATH.
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$paths    = if ($userPath) { $userPath -split ';' } else { @() }
if ($paths -notcontains $binDir) {
    $newPath = (@($binDir) + $paths | Where-Object { $_ }) -join ';'
    [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
    Write-Host "[claudio] added $binDir to user PATH (open a new terminal to pick up)" `
        -ForegroundColor Green
} else {
    Write-Host "[claudio] $binDir already on PATH" -ForegroundColor DarkGray
}

# 4. Make the wrapper available in *this* session too, so the user can try it now.
if ($env:Path -notlike "*$binDir*") {
    $env:Path = "$binDir;$env:Path"
}

Write-Host ""
Write-Host "Done. Try it:" -ForegroundColor Cyan
Write-Host "    claudio --version" -ForegroundColor Cyan

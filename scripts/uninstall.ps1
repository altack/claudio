#Requires -Version 5.1
<#
.SYNOPSIS
    Remove the claudio wrapper. Does NOT touch the running container or volumes.

.DESCRIPTION
    Run `podman compose down -v` separately if you also want to stop the
    container and delete OAuth tokens / spend history.
#>

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$binDir  = Join-Path $env:USERPROFILE '.claude\bin'
$cfgDir  = Join-Path $env:USERPROFILE '.claudio'

foreach ($name in @('claudio.ps1','claudio.cmd')) {
    $p = Join-Path $binDir $name
    if (Test-Path -LiteralPath $p) {
        Remove-Item -LiteralPath $p -Force
        Write-Host "removed $p"
    }
}

# Drop the master key file too. Tokens themselves live in the container volume.
if (Test-Path -LiteralPath $cfgDir) {
    Remove-Item -LiteralPath $cfgDir -Recurse -Force
    Write-Host "removed $cfgDir"
}

# Strip the bin dir from user PATH (if we added it).
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($userPath) {
    $kept = $userPath -split ';' | Where-Object { $_ -and ($_ -ne $binDir) }
    [Environment]::SetEnvironmentVariable('Path', ($kept -join ';'), 'User')
    Write-Host "removed $binDir from user PATH"
}

Write-Host ""
Write-Host "Wrapper uninstalled. The container is still running."
Write-Host "To stop it and wipe tokens:    podman compose down -v"

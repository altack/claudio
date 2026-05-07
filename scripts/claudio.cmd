@echo off
rem Thin shim so `claudio` works from cmd, PowerShell, and Git Bash without
rem requiring .ps1 in PATHEXT. Prefers PowerShell 7 (pwsh) and falls back
rem to Windows PowerShell.
where pwsh >nul 2>&1
if %errorlevel%==0 (
    pwsh -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0claudio.ps1" %*
) else (
    powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0claudio.ps1" %*
)

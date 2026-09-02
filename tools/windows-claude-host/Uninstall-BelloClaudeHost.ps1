<#
.SYNOPSIS
    Removes everything Install-BelloClaudeHost.ps1 created.
.DESCRIPTION
    Unregisters the scheduled task, stops a running host, and restores the
    AC sleep timeouts if -ConfigurePower had changed them.
    Logs are kept unless -RemoveLogs is given.
    Claude Code itself and your login are never touched.
#>
[CmdletBinding()]
param(
    [string] $ConfigPath = (Join-Path $PSScriptRoot 'bello-claude-host.config.psd1'),
    [string] $TaskName   = 'ClaudeCodeRemoteControl',
    [string] $TaskPath   = '\BELLO\',
    [switch] $RemoveLogs
)

$ErrorActionPreference = 'Continue'

$config = @{ LogRoot = '' }
if (Test-Path -LiteralPath $ConfigPath) {
    $fromFile = Import-PowerShellDataFile -LiteralPath $ConfigPath
    foreach ($k in $fromFile.Keys) { $config[$k] = $fromFile[$k] }
}
if ([string]::IsNullOrWhiteSpace($config.LogRoot)) {
    $config.LogRoot = Join-Path $env:LOCALAPPDATA 'BELLO\claude-host'
}
$stateDir = Join-Path $config.LogRoot 'state'

Write-Host '=== Stopping the host ===' -ForegroundColor Cyan
& (Join-Path $PSScriptRoot 'Stop-BelloClaudeHost.ps1') -ConfigPath $ConfigPath -StopTask `
    -TaskName $TaskName -TaskPath $TaskPath

Write-Host "`n=== Removing the scheduled task ===" -ForegroundColor Cyan
$removed = $false
foreach ($path in @($TaskPath, '\')) {
    try {
        $t = Get-ScheduledTask -TaskName $TaskName -TaskPath $path -ErrorAction Stop
        Unregister-ScheduledTask -TaskName $TaskName -TaskPath $path -Confirm:$false -ErrorAction Stop
        Write-Host "  Removed: $path$TaskName" -ForegroundColor Green
        $removed = $true
    } catch { }
}
if (-not $removed) { Write-Host '  No scheduled task to remove.' }

Write-Host "`n=== Restoring sleep settings ===" -ForegroundColor Cyan
$backupFile = Join-Path $stateDir 'powercfg-backup.json'
if (Test-Path -LiteralPath $backupFile) {
    try {
        $backup = Get-Content -LiteralPath $backupFile -Raw | ConvertFrom-Json
        $ok = $true
        if ($backup.standbyTimeoutAcSeconds -ge 0) {
            powercfg /change standby-timeout-ac $backup.standbyTimeoutAcSeconds 2>&1 | Out-Null
            if ($LASTEXITCODE -ne 0) { $ok = $false }
        }
        if ($backup.hibernateTimeoutAcSeconds -ge 0) {
            powercfg /change hibernate-timeout-ac $backup.hibernateTimeoutAcSeconds 2>&1 | Out-Null
            if ($LASTEXITCODE -ne 0) { $ok = $false }
        }
        if ($ok) {
            Write-Host "  Restored AC sleep=$($backup.standbyTimeoutAcSeconds)s hibernate=$($backup.hibernateTimeoutAcSeconds)s" -ForegroundColor Green
            Remove-Item -LiteralPath $backupFile -Force -ErrorAction SilentlyContinue
        } else {
            Write-Host '  powercfg refused without elevation. Run these in an Administrator PowerShell:' -ForegroundColor Magenta
            Write-Host "      powercfg /change standby-timeout-ac $($backup.standbyTimeoutAcSeconds)"
            Write-Host "      powercfg /change hibernate-timeout-ac $($backup.hibernateTimeoutAcSeconds)"
        }
    } catch {
        Write-Warning ("Could not restore power settings: {0}" -f $_.Exception.Message)
    }
} else {
    Write-Host '  No power settings were ever changed by this tool; nothing to restore.'
}

if ($RemoveLogs) {
    Write-Host "`n=== Removing logs and state ===" -ForegroundColor Cyan
    try {
        Remove-Item -LiteralPath $config.LogRoot -Recurse -Force -ErrorAction Stop
        Write-Host "  Removed $($config.LogRoot)" -ForegroundColor Green
    } catch {
        Write-Warning ("Could not remove logs: {0}" -f $_.Exception.Message)
    }
} else {
    Write-Host "`nLogs kept at $($config.LogRoot). Use -RemoveLogs to delete them."
}

Write-Host "`nDone. Claude Code itself, your login and the repository were not modified." -ForegroundColor Green

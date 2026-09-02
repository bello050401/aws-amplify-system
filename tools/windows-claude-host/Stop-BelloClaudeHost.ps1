<#
.SYNOPSIS
    Stops the BELLO Claude Code host without it restarting itself.
.DESCRIPTION
    Writes a stop flag the supervisor checks, so the running Claude Code
    server is shut down and the supervisor exits instead of restarting.
    The flag is cleared automatically the next time the host starts.
#>
[CmdletBinding()]
param(
    [string] $ConfigPath = (Join-Path $PSScriptRoot 'bello-claude-host.config.psd1'),
    # Also stop the scheduled task instance.
    [switch] $StopTask,
    [string] $TaskName = 'ClaudeCodeRemoteControl',
    [string] $TaskPath = '\BELLO\'
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
if (-not (Test-Path -LiteralPath $stateDir)) { New-Item -ItemType Directory -Path $stateDir -Force | Out-Null }

$stopFlag = Join-Path $stateDir 'stop.flag'
Set-Content -LiteralPath $stopFlag -Value ((Get-Date).ToString('o')) -Encoding UTF8
Write-Host "Stop flag written: $stopFlag" -ForegroundColor Cyan
Write-Host 'The supervisor stops Claude Code within ~15 seconds and exits without restarting.'

if ($StopTask) {
    try {
        Stop-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -ErrorAction Stop
        Write-Host "Scheduled task instance stopped: $TaskPath$TaskName" -ForegroundColor Cyan
    } catch {
        Write-Warning ("Could not stop the scheduled task: {0}" -f $_.Exception.Message)
    }
}

Write-Host 'Start it again with Start-BelloClaudeHost.ps1, or by logging off and back on.'

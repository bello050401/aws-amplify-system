<#
.SYNOPSIS
    Read-only status of the BELLO Claude Code Remote Control host.
.DESCRIPTION
    Shows whether the host is running, what the scheduled task is doing,
    the last recorded state, current sleep settings and the tail of the log.
    Changes nothing.
#>
[CmdletBinding()]
param(
    [string] $ConfigPath,
    [string] $TaskName   = 'ClaudeCodeRemoteControl',
    [string] $TaskPath   = '\BELLO\',
    [int]    $LogLines   = 25
)

# ---------------------------------------------------------------------------
# Script directory resolution - Windows PowerShell 5.1 safe.
#
# Never use $BelloScriptDir in a param() default. PowerShell evaluates parameter
# defaults BEFORE the script body runs, and $BelloScriptDir is empty whenever the
# script is dot-sourced, run through Invoke-Expression, executed from an editor
# selection, or hosted without a script context. Join-Path then fails with
# "Cannot bind argument to parameter 'Path' because it is an empty string"
# before any of this script's own code gets a chance to run.
#
# Resolve the directory here instead, at script scope, where $MyInvocation
# still refers to this script, with the current directory as a last resort.
# ---------------------------------------------------------------------------
$BelloScriptDir = ''
if (-not [string]::IsNullOrWhiteSpace($PSScriptRoot)) {
    $BelloScriptDir = $PSScriptRoot
}
if ([string]::IsNullOrWhiteSpace($BelloScriptDir) -and -not [string]::IsNullOrWhiteSpace($PSCommandPath)) {
    $BelloScriptDir = Split-Path -Parent $PSCommandPath
}
if ([string]::IsNullOrWhiteSpace($BelloScriptDir)) {
    $belloInvocationPath = ''
    if ($MyInvocation -and $MyInvocation.MyCommand) {
        $belloInvocationPath = [string]$MyInvocation.MyCommand.Path
    }
    if (-not [string]::IsNullOrWhiteSpace($belloInvocationPath)) {
        $BelloScriptDir = Split-Path -Parent $belloInvocationPath
    }
}
if ([string]::IsNullOrWhiteSpace($BelloScriptDir)) {
    $BelloScriptDir = (Get-Location).ProviderPath
}
if ([string]::IsNullOrWhiteSpace($BelloScriptDir)) {
    $BelloScriptDir = '.'
}
# If the toolkit files are not beside the resolved directory but they are in
# the current directory, prefer the current directory.
if (-not (Test-Path -LiteralPath (Join-Path $BelloScriptDir 'bello-claude-host.config.psd1'))) {
    $belloCurrentDir = (Get-Location).ProviderPath
    if ((-not [string]::IsNullOrWhiteSpace($belloCurrentDir)) -and
        (Test-Path -LiteralPath (Join-Path $belloCurrentDir 'bello-claude-host.config.psd1'))) {
        $BelloScriptDir = $belloCurrentDir
    }
}

if ([string]::IsNullOrWhiteSpace($ConfigPath)) {
    $ConfigPath = Join-Path $BelloScriptDir 'bello-claude-host.config.psd1'
}

$ErrorActionPreference = 'Continue'

$config = @{ RepoPath = ''; SessionName = 'BELLO-dev'; LogRoot = '' }
if (Test-Path -LiteralPath $ConfigPath) {
    $fromFile = Import-PowerShellDataFile -LiteralPath $ConfigPath
    foreach ($k in $fromFile.Keys) { $config[$k] = $fromFile[$k] }
}
if ([string]::IsNullOrWhiteSpace($config.LogRoot)) {
    # LOCALAPPDATA can be absent in some non-interactive contexts; resolve it
    # without depending on the environment variable so Join-Path never receives
    # an empty string.
    $belloLocalAppData = [string]$env:LOCALAPPDATA
    if ([string]::IsNullOrWhiteSpace($belloLocalAppData)) {
        $belloLocalAppData = [Environment]::GetFolderPath('LocalApplicationData')
    }
    if ([string]::IsNullOrWhiteSpace($belloLocalAppData) -and -not [string]::IsNullOrWhiteSpace($env:USERPROFILE)) {
        $belloLocalAppData = Join-Path $env:USERPROFILE 'AppData\Local'
    }
    if ([string]::IsNullOrWhiteSpace($belloLocalAppData)) {
        $belloLocalAppData = $BelloScriptDir
    }
    $config.LogRoot = Join-Path $belloLocalAppData 'BELLO\claude-host'
}
$logDir   = Join-Path $config.LogRoot 'logs'
$stateDir = Join-Path $config.LogRoot 'state'

function Section { param([string]$t) Write-Host "`n=== $t ===" -ForegroundColor Cyan }

Section 'Host process'
$pidFile = Join-Path $stateDir 'supervisor.pid'
if (Test-Path -LiteralPath $pidFile) {
    $hostPidText = (Get-Content -LiteralPath $pidFile -Raw).Trim()
    $hostPid = 0
    if (-not [int]::TryParse($hostPidText, [ref]$hostPid)) {
        Write-Host "  PID file is unreadable (contents: '$hostPidText')." -ForegroundColor Yellow
    } else {
        $proc = Get-Process -Id $hostPid -ErrorAction SilentlyContinue
        if ($proc) {
            Write-Host "  Supervisor RUNNING (pid $hostPid, started $($proc.StartTime))" -ForegroundColor Green
        } else {
            Write-Host "  Stale PID file (pid $hostPid is gone). Supervisor is NOT running." -ForegroundColor Yellow
        }
    }
} else {
    Write-Host '  Supervisor is not running (no PID file).' -ForegroundColor Yellow
}

$claudeProcs = @(Get-Process -Name 'claude' -ErrorAction SilentlyContinue)
Write-Host ("  claude processes: {0}{1}" -f $claudeProcs.Count,
    $(if ($claudeProcs.Count) { ' (pids: ' + (($claudeProcs | ForEach-Object { $_.Id }) -join ', ') + ')' } else { '' }))
if ($claudeProcs.Count -gt 1) {
    Write-Host '  More than one claude process is running. That is fine if you also use Claude Code interactively elsewhere.' -ForegroundColor Yellow
}

Section 'Scheduled task'
try {
    $task = Get-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -ErrorAction Stop
    Write-Host "  $($task.TaskPath)$($task.TaskName) - state: $($task.State)" -ForegroundColor Green
    $info = Get-ScheduledTaskInfo -TaskName $TaskName -TaskPath $TaskPath -ErrorAction SilentlyContinue
    if ($info) {
        Write-Host "  Last run    : $($info.LastRunTime)"
        Write-Host ("  Last result : 0x{0:X} ({0})" -f $info.LastTaskResult)
        Write-Host "  Next run    : $($info.NextRunTime)"
    }
} catch {
    Write-Host "  Task $TaskPath$TaskName is NOT registered." -ForegroundColor Yellow
}

Section 'Last recorded state'
$statePath = Join-Path $stateDir 'state.json'
if (Test-Path -LiteralPath $statePath) {
    Get-Content -LiteralPath $statePath -Raw | Write-Host
} else {
    Write-Host '  No state file yet.'
}

Section 'Power'
try {
    $batteries = @(Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue)
    if ($batteries.Count -eq 0) {
        Write-Host '  No battery detected (desktop) - always treated as AC power.'
    } else {
        foreach ($b in $batteries) {
            $onAc = if ($b.BatteryStatus -ne 1) { 'AC' } else { 'battery' }
            Write-Host ("  Battery status: {0} ({1}), charge {2}%" -f $b.BatteryStatus, $onAc, $b.EstimatedChargeRemaining)
        }
    }
} catch { Write-Host '  Battery state unavailable.' }
Write-Host ('  ' + ((powercfg /getactivescheme) 2>&1))
$q = powercfg /query SCHEME_CURRENT SUB_SLEEP STANDBYIDLE 2>&1 | Out-String
if ($q -match 'Current AC Power Setting Index:\s*0x([0-9a-fA-F]+)') {
    $sec = [Convert]::ToInt32($Matches[1], 16)
    Write-Host ("  AC sleep timeout: {0}" -f $(if ($sec -eq 0) { 'never' } else { "$sec s" }))
}

Section "Log tail ($logDir)"
if (Test-Path -LiteralPath $logDir) {
    $latest = Get-ChildItem -LiteralPath $logDir -Filter 'supervisor-*.log' -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($latest) {
        Write-Host "  $($latest.FullName)"
        Get-Content -LiteralPath $latest.FullName -Tail $LogLines | ForEach-Object { Write-Host "    $_" }
    } else {
        Write-Host '  No supervisor log yet.'
    }
} else {
    Write-Host '  Log directory does not exist yet.'
}

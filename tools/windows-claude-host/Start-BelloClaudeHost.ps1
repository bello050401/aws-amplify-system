<#
.SYNOPSIS
    Supervises a Claude Code Remote Control server for the BELLO repository.

.DESCRIPTION
    Starts `claude remote-control` in the BELLO repository and keeps it running:

      * single instance only (named mutex + PID file) - never starts a second
        Claude Code host on this machine;
      * restarts the server if it exits unexpectedly, with exponential backoff;
      * refuses to restart-loop forever: more than MaxRestarts failures inside
        CrashWindowMinutes stops the supervisor and records why;
      * a clean exit (exit code 0, e.g. you pressed Ctrl+C) is treated as
        "you meant to stop" and is NOT restarted;
      * while running on AC power, asks Windows not to enter system sleep
        (the display is still allowed to turn off, and the lock screen is
        unaffected). Released automatically on exit;
      * writes a lifecycle log a human can read afterwards.

    This script contains no credentials. Claude Code authentication, AWS
    credentials and GitHub tokens all come from their own stores.

.NOTES
    Requires Windows PowerShell 5.1 or PowerShell 7+.
    No administrator rights required.
#>
[CmdletBinding()]
param(
    # Repository to run Claude Code in. Overrides the config file.
    [string] $RepoPath,

    # Remote Control session title shown at claude.ai/code.
    [string] $SessionName,

    # Directory for logs and runtime state.
    [string] $LogRoot,

    # Path to the .psd1 config file.
    [string] $ConfigPath,

    # Run the server once and exit when it exits; no restart supervision.
    [switch] $Once,

    # Do not hold the "no system sleep" request.
    [switch] $NoSleepInhibit,

    # Redirect the server's console output to a log file instead of the
    # console. Use for an invisible background host; you lose the live URL /
    # QR-code display and keyboard interaction with the server.
    [switch] $Hidden,

    # Print what would be launched, then exit without starting anything.
    [switch] $WhatIfLaunch
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

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

# --------------------------------------------------------------------------
# Configuration
# --------------------------------------------------------------------------

$config = @{
    RepoPath           = 'C:\Users\win\Documents\GitHub\aws-amplify-system'
    SessionName        = 'BELLO-dev'
    LogRoot            = ''
    MaxRestarts        = 5
    CrashWindowMinutes = 10
    HealthySeconds     = 120
    BaseBackoffSeconds = 5
    MaxBackoffSeconds  = 300
    InhibitSleepOnAC   = $true
    LogRetentionDays   = 30
}

if (Test-Path -LiteralPath $ConfigPath) {
    try {
        $fromFile = Import-PowerShellDataFile -LiteralPath $ConfigPath
        foreach ($key in $fromFile.Keys) { $config[$key] = $fromFile[$key] }
    } catch {
        Write-Warning ("Could not read config '{0}': {1}. Using built-in defaults." -f $ConfigPath, $_.Exception.Message)
    }
}

if ($PSBoundParameters.ContainsKey('RepoPath'))    { $config.RepoPath    = $RepoPath }
if ($PSBoundParameters.ContainsKey('SessionName')) { $config.SessionName = $SessionName }
if ($PSBoundParameters.ContainsKey('LogRoot'))     { $config.LogRoot     = $LogRoot }

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

$logDir    = Join-Path $config.LogRoot 'logs'
$stateDir  = Join-Path $config.LogRoot 'state'
$statePath = Join-Path $stateDir 'state.json'
$pidPath   = Join-Path $stateDir 'supervisor.pid'
$stopFlag  = Join-Path $stateDir 'stop.flag'

foreach ($dir in @($config.LogRoot, $logDir, $stateDir)) {
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
}

$script:LogFile = Join-Path $logDir ('supervisor-{0}.log' -f (Get-Date -Format 'yyyyMMdd'))

# --------------------------------------------------------------------------
# Logging
# --------------------------------------------------------------------------

function Write-HostLog {
    param(
        [Parameter(Mandatory)][string] $Message,
        [ValidateSet('INFO', 'WARN', 'ERROR', 'FATAL', 'START', 'STOP')]
        [string] $Level = 'INFO'
    )
    $line = '{0} [{1,-5}] (pid {2}) {3}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss.fff'), $Level, $PID, $Message
    try { Add-Content -LiteralPath $script:LogFile -Value $line -Encoding UTF8 } catch { }
    switch ($Level) {
        'ERROR' { Write-Host $line -ForegroundColor Red }
        'FATAL' { Write-Host $line -ForegroundColor Red }
        'WARN'  { Write-Host $line -ForegroundColor Yellow }
        'START' { Write-Host $line -ForegroundColor Green }
        'STOP'  { Write-Host $line -ForegroundColor Cyan }
        default { Write-Host $line }
    }
}

function Save-HostState {
    param([hashtable] $State)
    try {
        $State['updatedAt'] = (Get-Date).ToString('o')
        $State | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $statePath -Encoding UTF8
    } catch {
        Write-HostLog -Level WARN -Message ("Could not write state file: {0}" -f $_.Exception.Message)
    }
}

function Remove-OldLogs {
    param([int] $RetentionDays)
    if ($RetentionDays -le 0) { return }
    try {
        $cutoff = (Get-Date).AddDays(-$RetentionDays)
        Get-ChildItem -LiteralPath $logDir -File -ErrorAction SilentlyContinue |
            Where-Object { $_.LastWriteTime -lt $cutoff } |
            Remove-Item -Force -ErrorAction SilentlyContinue
    } catch { }
}

# --------------------------------------------------------------------------
# Locate the Claude Code executable
# --------------------------------------------------------------------------

function Resolve-ClaudeLauncher {
    <#
        Returns a hashtable: File, PrefixArgs, Kind, Detail.
        Preference order - most stable first:
          1. claude(.exe|.cmd) already on PATH
          2. native install at %USERPROFILE%\.local\bin\claude.exe
          3. npm global shim at %APPDATA%\npm\claude.cmd
          4. npx.cmd @anthropic-ai/claude-code   (slowest, network dependent)
    #>
    $cmd = Get-Command -Name 'claude' -CommandType Application -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($cmd) {
        return @{ File = $cmd.Source; PrefixArgs = @(); Kind = 'path'; Detail = 'claude found on PATH' }
    }

    if (-not [string]::IsNullOrWhiteSpace($env:USERPROFILE)) {
        $native = Join-Path $env:USERPROFILE '.local\bin\claude.exe'
        if (Test-Path -LiteralPath $native) {
            return @{ File = $native; PrefixArgs = @(); Kind = 'native'; Detail = 'native install (not on PATH)' }
        }
    }

    if (-not [string]::IsNullOrWhiteSpace($env:APPDATA)) {
        foreach ($leaf in @('claude.cmd', 'claude.exe')) {
            $npmShim = Join-Path $env:APPDATA ('npm\' + $leaf)
            if (Test-Path -LiteralPath $npmShim) {
                return @{ File = $npmShim; PrefixArgs = @(); Kind = 'npm'; Detail = 'npm global install (not on PATH)' }
            }
        }
    }

    $npx = Get-Command -Name 'npx.cmd' -CommandType Application -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if (-not $npx) {
        $npx = Get-Command -Name 'npx' -CommandType Application -ErrorAction SilentlyContinue |
            Select-Object -First 1
    }
    if ($npx) {
        return @{
            File       = $npx.Source
            PrefixArgs = @('--yes', '@anthropic-ai/claude-code')
            Kind       = 'npx'
            Detail     = 'npx fallback - re-resolves the package on every launch (slow, needs network)'
        }
    }

    return $null
}

# --------------------------------------------------------------------------
# Power / sleep handling
# --------------------------------------------------------------------------

$script:PowerTypeReady = $false

function Initialize-PowerApi {
    if ($script:PowerTypeReady) { return $true }
    try {
        if (-not ('Bello.PowerUtil' -as [type])) {
            Add-Type -Namespace 'Bello' -Name 'PowerUtil' -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true)]
public static extern uint SetThreadExecutionState(uint esFlags);
'@
        }
        $script:PowerTypeReady = $true
        return $true
    } catch {
        Write-HostLog -Level WARN -Message ("Sleep inhibition unavailable: {0}" -f $_.Exception.Message)
        return $false
    }
}

function Test-OnAcPower {
    # No battery at all (desktop) counts as AC.
    try {
        $batteries = @(Get-CimInstance -ClassName Win32_Battery -ErrorAction Stop)
        if ($batteries.Count -eq 0) { return $true }
        # BatteryStatus 1 = discharging (on battery); anything else involves AC.
        foreach ($b in $batteries) { if ($b.BatteryStatus -ne 1) { return $true } }
        return $false
    } catch {
        return $true
    }
}

# ES_CONTINUOUS = 0x80000000, ES_SYSTEM_REQUIRED = 0x00000001.
# Written as decimal: Windows PowerShell 5.1 and PowerShell 7 differ in how
# they widen a '0x...' string cast, and 0x80000000 overflows a signed int.
$ES_CONTINUOUS       = [uint32]2147483648
$ES_SYSTEM_REQUIRED  = [uint32]1
$script:SleepHeld    = $false

function Set-SleepInhibition {
    <#
        Holds ES_SYSTEM_REQUIRED so Windows does not put the machine to sleep
        while the host runs. ES_DISPLAY_REQUIRED is deliberately not set: the
        monitor still turns off on schedule and the lock screen still engages,
        so this does not weaken screen-lock security. Windows drops the request
        automatically if this process dies.
    #>
    param([bool] $Enable)

    if (-not (Initialize-PowerApi)) { return }
    try {
        if ($Enable) {
            [void][Bello.PowerUtil]::SetThreadExecutionState($ES_CONTINUOUS -bor $ES_SYSTEM_REQUIRED)
            if (-not $script:SleepHeld) {
                Write-HostLog -Message 'System sleep inhibited (AC power). Display sleep and lock screen are unchanged.'
            }
            $script:SleepHeld = $true
        } else {
            [void][Bello.PowerUtil]::SetThreadExecutionState($ES_CONTINUOUS)
            if ($script:SleepHeld) {
                Write-HostLog -Message 'System sleep inhibition released.'
            }
            $script:SleepHeld = $false
        }
    } catch {
        Write-HostLog -Level WARN -Message ("Could not change sleep inhibition: {0}" -f $_.Exception.Message)
    }
}

function Update-SleepInhibition {
    if ($NoSleepInhibit -or -not $config.InhibitSleepOnAC) { return }
    Set-SleepInhibition -Enable (Test-OnAcPower)
}

# --------------------------------------------------------------------------
# Environment diagnostics
# --------------------------------------------------------------------------

function Write-EnvironmentDiagnostics {
    param([hashtable] $Launcher)

    Write-HostLog -Message ('Host            : {0} / user {1}' -f $env:COMPUTERNAME, $env:USERNAME)
    Write-HostLog -Message ('PowerShell      : {0}' -f $PSVersionTable.PSVersion)
    Write-HostLog -Message ('Repository      : {0}' -f $config.RepoPath)
    Write-HostLog -Message ('Session name    : {0}' -f $config.SessionName)
    Write-HostLog -Message ('Claude launcher : {0} [{1}] - {2}' -f $Launcher.File, $Launcher.Kind, $Launcher.Detail)
    Write-HostLog -Message ('Log directory   : {0}' -f $logDir)

    if ($Launcher.Kind -eq 'npx') {
        Write-HostLog -Level WARN -Message 'Running via npx. Install Claude Code natively for faster, offline-tolerant startup (see README).'
    }

    try {
        $verArgs = @($Launcher.PrefixArgs + @('--version'))
        $version = & $Launcher.File @verArgs 2>&1 | Select-Object -First 1
        Write-HostLog -Message ('Claude version  : {0}' -f $version)
    } catch {
        Write-HostLog -Level WARN -Message ("Could not read Claude Code version: {0}" -f $_.Exception.Message)
    }

    # These environment variables are documented to break Remote Control.
    $blockers = @(
        'DISABLE_TELEMETRY',
        'DO_NOT_TRACK',
        'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
        'DISABLE_GROWTHBOOK'
    )
    foreach ($name in $blockers) {
        $value = [Environment]::GetEnvironmentVariable($name)
        if (-not [string]::IsNullOrWhiteSpace($value)) {
            Write-HostLog -Level WARN -Message ("Environment variable {0}={1} is set. It disables the feature-flag evaluation Remote Control depends on; unset it if Remote Control fails to connect." -f $name, $value)
        }
    }
    $baseUrl = [Environment]::GetEnvironmentVariable('ANTHROPIC_BASE_URL')
    if (-not [string]::IsNullOrWhiteSpace($baseUrl) -and $baseUrl -notmatch 'api\.anthropic\.com') {
        Write-HostLog -Level WARN -Message ("ANTHROPIC_BASE_URL={0} points away from api.anthropic.com. Remote Control is unavailable until it is unset." -f $baseUrl)
    }

    if (-not (Test-Path -LiteralPath (Join-Path $config.RepoPath '.git'))) {
        Write-HostLog -Level WARN -Message 'Repository path is not a git working tree; the remote diff pane will be unavailable.'
    }
}

# --------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------

$mutex        = $null
$mutexOwned   = $false
$exitCode     = 0
$failureTimes = New-Object System.Collections.ArrayList

try {
    Remove-OldLogs -RetentionDays $config.LogRetentionDays

    # ---- Single instance ------------------------------------------------
    # Local\ (per-session) namespace: no administrator rights needed.
    $mutex = New-Object System.Threading.Mutex($false, 'Local\BELLO-ClaudeCodeHost')
    try {
        $mutexOwned = $mutex.WaitOne(0)
    } catch [System.Threading.AbandonedMutexException] {
        # Previous holder died without releasing; we now own it.
        $mutexOwned = $true
    }

    if (-not $mutexOwned) {
        $other = 'unknown'
        if (Test-Path -LiteralPath $pidPath) { $other = (Get-Content -LiteralPath $pidPath -Raw).Trim() }
        Write-HostLog -Level WARN -Message ("Another BELLO Claude Code host is already running (pid {0}). Exiting without starting a second one." -f $other)
        exit 0
    }

    Set-Content -LiteralPath $pidPath -Value $PID -Encoding ASCII

    # A stop flag left over from a previous deliberate stop must not block startup.
    if (Test-Path -LiteralPath $stopFlag) { Remove-Item -LiteralPath $stopFlag -Force -ErrorAction SilentlyContinue }

    Write-HostLog -Level START -Message '=== BELLO Claude Code host starting ==='

    # ---- Preconditions ---------------------------------------------------
    if (-not (Test-Path -LiteralPath $config.RepoPath)) {
        Write-HostLog -Level FATAL -Message ("Repository path not found: {0}. Fix RepoPath in {1}." -f $config.RepoPath, $ConfigPath)
        exit 2
    }

    $launcher = Resolve-ClaudeLauncher
    if ($null -eq $launcher) {
        Write-HostLog -Level FATAL -Message 'Claude Code was not found (no claude on PATH, no native install, no npm global install, no npx). Install it - see README.md.'
        exit 3
    }

    Write-EnvironmentDiagnostics -Launcher $launcher

    $debugLog = Join-Path $logDir ('claude-debug-{0}.log' -f (Get-Date -Format 'yyyyMMdd-HHmmss'))

    # Flags for `claude remote-control` must come AFTER the subcommand;
    # a global flag placed before it is rejected by Claude Code.
    $claudeArgs = @($launcher.PrefixArgs) + @(
        'remote-control',
        '--name', $config.SessionName,
        '--debug-file', $debugLog
    )

    Write-HostLog -Message ('Launch command  : "{0}" {1}' -f $launcher.File, ($claudeArgs -join ' '))
    Write-HostLog -Message ('Claude debug log: {0}' -f $debugLog)

    if ($WhatIfLaunch) {
        Write-HostLog -Message 'WhatIfLaunch specified - not starting Claude Code.'
        exit 0
    }

    Update-SleepInhibition

    $attempt = 0
    while ($true) {
        if (Test-Path -LiteralPath $stopFlag) {
            Write-HostLog -Level STOP -Message 'Stop flag present; not starting Claude Code.'
            break
        }

        $attempt++
        $startedAt = Get-Date
        Write-HostLog -Level START -Message ('Starting Claude Code Remote Control server (attempt {0}) in {1}' -f $attempt, $config.RepoPath)

        Save-HostState -State @{
            status         = 'running'
            supervisorPid  = $PID
            repoPath       = $config.RepoPath
            sessionName    = $config.SessionName
            launcher       = $launcher.File
            launcherKind   = $launcher.Kind
            attempt        = $attempt
            startedAt      = $startedAt.ToString('o')
            claudeDebugLog = $debugLog
            logFile        = $script:LogFile
        }

        $startArgs = @{
            FilePath         = $launcher.File
            ArgumentList     = $claudeArgs
            WorkingDirectory = $config.RepoPath
            PassThru         = $true
            NoNewWindow      = $true
        }
        if ($Hidden) {
            $startArgs['RedirectStandardOutput'] = Join-Path $logDir ('claude-stdout-{0}.log' -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
            $startArgs['RedirectStandardError']  = Join-Path $logDir ('claude-stderr-{0}.log' -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
        }

        $proc = $null
        try {
            $proc = Start-Process @startArgs
        } catch {
            Write-HostLog -Level ERROR -Message ("Failed to launch Claude Code: {0}" -f $_.Exception.Message)
        }

        if ($null -ne $proc) {
            Write-HostLog -Message ('Claude Code running as pid {0}. The session URL is printed in this window and at claude.ai/code.' -f $proc.Id)

            # Poll so we can re-evaluate AC state and the stop flag while waiting.
            while (-not $proc.HasExited) {
                [void]$proc.WaitForExit(15000)
                if ($proc.HasExited) { break }
                Update-SleepInhibition
                if (Test-Path -LiteralPath $stopFlag) {
                    Write-HostLog -Level STOP -Message 'Stop flag detected; stopping Claude Code.'
                    try { $proc.CloseMainWindow() | Out-Null } catch { }
                    Start-Sleep -Seconds 3
                    if (-not $proc.HasExited) {
                        try { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } catch { }
                    }
                    break
                }
            }
        }

        $ranSeconds = [int]((Get-Date) - $startedAt).TotalSeconds
        $childExit  = 1
        if ($null -ne $proc -and $proc.HasExited) { $childExit = $proc.ExitCode }

        Write-HostLog -Level STOP -Message ('Claude Code exited with code {0} after {1}s.' -f $childExit, $ranSeconds)

        if (Test-Path -LiteralPath $stopFlag) {
            Write-HostLog -Level STOP -Message 'Deliberate stop requested. Supervisor exiting without restart.'
            Save-HostState -State @{ status = 'stopped-by-request'; lastExitCode = $childExit; ranSeconds = $ranSeconds }
            break
        }

        if ($Once) {
            Write-HostLog -Level STOP -Message '-Once specified. Supervisor exiting without restart.'
            Save-HostState -State @{ status = 'stopped-once'; lastExitCode = $childExit; ranSeconds = $ranSeconds }
            $exitCode = $childExit
            break
        }

        if ($childExit -eq 0) {
            # Ctrl+C / graceful shutdown - the operator meant to stop.
            Write-HostLog -Level STOP -Message 'Clean exit (code 0) treated as an intentional shutdown. Not restarting.'
            Save-HostState -State @{ status = 'stopped-clean'; lastExitCode = 0; ranSeconds = $ranSeconds }
            break
        }

        # ---- Crash-loop protection --------------------------------------
        if ($ranSeconds -ge $config.HealthySeconds) {
            if ($failureTimes.Count -gt 0) {
                Write-HostLog -Message ('Previous run lasted {0}s (healthy); resetting the failure counter.' -f $ranSeconds)
            }
            $failureTimes.Clear()
        }

        [void]$failureTimes.Add((Get-Date))
        $windowStart = (Get-Date).AddMinutes(-$config.CrashWindowMinutes)
        $recent = @($failureTimes | Where-Object { $_ -ge $windowStart })
        $failureTimes.Clear()
        foreach ($t in $recent) { [void]$failureTimes.Add($t) }

        if ($failureTimes.Count -ge $config.MaxRestarts) {
            Write-HostLog -Level FATAL -Message ('Claude Code failed {0} times within {1} minutes (last exit code {2}). Stopping to avoid a restart loop. Investigate {3} and the Claude debug log {4}, then start the host again manually or log off and back on.' -f $failureTimes.Count, $config.CrashWindowMinutes, $childExit, $script:LogFile, $debugLog)
            Write-HostLog -Level FATAL -Message 'Common causes: not signed in (run `claude` in the repo and use /login), workspace trust not accepted yet, or no network.'
            Save-HostState -State @{
                status         = 'crash-loop-stopped'
                failures       = $failureTimes.Count
                windowMinutes  = $config.CrashWindowMinutes
                lastExitCode   = $childExit
                claudeDebugLog = $debugLog
                logFile        = $script:LogFile
            }
            $exitCode = 4
            break
        }

        $backoff = [Math]::Min(
            $config.BaseBackoffSeconds * [Math]::Pow(2, $failureTimes.Count - 1),
            $config.MaxBackoffSeconds)
        $backoff = [int]$backoff
        Write-HostLog -Level WARN -Message ('Restarting in {0}s (failure {1} of {2} allowed within {3} minutes).' -f $backoff, $failureTimes.Count, $config.MaxRestarts, $config.CrashWindowMinutes)
        Save-HostState -State @{
            status        = 'backoff'
            failures      = $failureTimes.Count
            lastExitCode  = $childExit
            restartInSec  = $backoff
        }
        Start-Sleep -Seconds $backoff
    }
}
catch {
    Write-HostLog -Level FATAL -Message ("Unhandled supervisor error: {0}`n{1}" -f $_.Exception.Message, $_.ScriptStackTrace)
    $exitCode = 5
}
finally {
    Set-SleepInhibition -Enable $false
    # Only the instance that owns the lock may clear the PID file - a blocked
    # second instance must not delete the running instance's file.
    if ($mutexOwned -and (Test-Path -LiteralPath $pidPath)) {
        Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue
    }
    if ($mutexOwned -and $null -ne $mutex) {
        try { $mutex.ReleaseMutex() } catch { }
    }
    if ($null -ne $mutex) { $mutex.Dispose() }
    Write-HostLog -Level STOP -Message ('=== BELLO Claude Code host stopped (exit {0}) ===' -f $exitCode)
}

exit $exitCode

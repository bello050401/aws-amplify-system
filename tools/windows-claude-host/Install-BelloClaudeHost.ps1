<#
.SYNOPSIS
    Sets up the BELLO Claude Code Remote Control host on this Windows PC.

.DESCRIPTION
    Idempotent, non-administrative setup:

      1. inspects the machine (PowerShell, Node/npm, Claude Code, repository);
      2. reports any EXISTING autostart entries so a duplicate Claude Code
         host is never created;
      3. optionally installs Claude Code natively when it is only reachable
         through npx (much faster and more reliable startup);
      4. registers a per-user scheduled task that starts the supervisor at
         logon (no administrator rights, no stored password);
      5. optionally changes the AC sleep timeout of the active power plan.

    Re-running this script updates the existing task instead of adding a
    second one.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\Install-BelloClaudeHost.ps1

.EXAMPLE
    # Also make the sleep setting permanent in the active power plan
    powershell -ExecutionPolicy Bypass -File .\Install-BelloClaudeHost.ps1 -ConfigurePower
#>
[CmdletBinding()]
param(
    [string] $RepoPath,
    [string] $SessionName,
    [string] $ConfigPath,

    # Task Scheduler location.
    [string] $TaskName = 'ClaudeCodeRemoteControl',
    [string] $TaskPath = '\BELLO\',

    # Seconds to wait after logon before starting (lets the network come up).
    [int] $StartDelaySeconds = 45,

    # never | auto (default, installs only when Claude Code is missing or
    # reachable through npx only) | always
    [ValidateSet('never', 'auto', 'always')]
    [string] $InstallNative = 'auto',

    # Also change the active power plan so the PC never sleeps on AC.
    # Off by default: the supervisor already prevents sleep while it runs,
    # without changing any global setting.
    [switch] $ConfigurePower,

    # Register the task to run without a visible console window.
    [switch] $Hidden,

    # Inspect and report only; change nothing.
    [switch] $ReportOnly
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

function Write-Step   { param([string]$m) Write-Host "`n=== $m ===" -ForegroundColor Cyan }
function Write-Ok     { param([string]$m) Write-Host "  [ok]   $m" -ForegroundColor Green }
function Write-Info   { param([string]$m) Write-Host "  [info] $m" }
function Write-Warn   { param([string]$m) Write-Host "  [warn] $m" -ForegroundColor Yellow }
function Write-Fail   { param([string]$m) Write-Host "  [FAIL] $m" -ForegroundColor Red }
function Write-Action { param([string]$m) Write-Host "  [YOU]  $m" -ForegroundColor Magenta }

$supervisor = Join-Path $BelloScriptDir 'Start-BelloClaudeHost.ps1'
if (-not (Test-Path -LiteralPath $supervisor)) {
    throw "Start-BelloClaudeHost.ps1 not found next to this script ($BelloScriptDir)."
}

# --------------------------------------------------------------------------
# 1. Load configuration
# --------------------------------------------------------------------------
Write-Step '1. Configuration'

$config = @{ RepoPath = ''; SessionName = 'BELLO-dev'; LogRoot = '' }
if (Test-Path -LiteralPath $ConfigPath) {
    $fromFile = Import-PowerShellDataFile -LiteralPath $ConfigPath
    foreach ($k in $fromFile.Keys) { $config[$k] = $fromFile[$k] }
    Write-Ok "Config loaded: $ConfigPath"
} else {
    Write-Warn "Config file not found at $ConfigPath; using defaults."
}
if ($PSBoundParameters.ContainsKey('RepoPath'))    { $config.RepoPath    = $RepoPath }
if ($PSBoundParameters.ContainsKey('SessionName')) { $config.SessionName = $SessionName }

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

Write-Info "Repository  : $($config.RepoPath)"
Write-Info "Session name: $($config.SessionName)"
Write-Info "Log root    : $($config.LogRoot)"

# --------------------------------------------------------------------------
# 2. Inspect the machine
# --------------------------------------------------------------------------
Write-Step '2. Environment inspection'

Write-Info ("Windows      : {0}" -f (Get-CimInstance Win32_OperatingSystem).Caption)
Write-Info ("PowerShell   : {0}" -f $PSVersionTable.PSVersion)
Write-Info ("User         : {0}" -f ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name))

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
    ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
Write-Info ("Elevated     : {0} (elevation is not required)" -f $isAdmin)

foreach ($tool in @('node', 'npm', 'npx', 'git')) {
    $c = Get-Command $tool -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($c) {
        $v = try { (& $tool --version 2>&1 | Select-Object -First 1) } catch { 'unknown' }
        Write-Ok ("{0,-4} : {1}  ({2})" -f $tool, $v, $c.Source)
    } else {
        Write-Warn ("{0,-4} : not found on PATH" -f $tool)
    }
}

if (Test-Path -LiteralPath $config.RepoPath) {
    Write-Ok "Repository exists: $($config.RepoPath)"
    if (Test-Path -LiteralPath (Join-Path $config.RepoPath '.git')) {
        Write-Ok 'Repository is a git working tree.'
    } else {
        Write-Warn 'Repository is not a git working tree.'
    }
} else {
    Write-Fail "Repository NOT found: $($config.RepoPath)"
    Write-Action "Fix RepoPath in $ConfigPath (or pass -RepoPath) and re-run."
    if (-not $ReportOnly) { exit 2 }
}

# --------------------------------------------------------------------------
# 3. Locate / install Claude Code
# --------------------------------------------------------------------------
Write-Step '3. Claude Code installation'

function Find-Claude {
    $c = Get-Command -Name 'claude' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($c) { return @{ File = $c.Source; Kind = 'path' } }
    if (-not [string]::IsNullOrWhiteSpace($env:USERPROFILE)) {
        $native = Join-Path $env:USERPROFILE '.local\bin\claude.exe'
        if (Test-Path -LiteralPath $native) { return @{ File = $native; Kind = 'native' } }
    }
    if (-not [string]::IsNullOrWhiteSpace($env:APPDATA)) {
        foreach ($leaf in @('claude.cmd', 'claude.exe')) {
            $p = Join-Path $env:APPDATA ('npm\' + $leaf)
            if (Test-Path -LiteralPath $p) { return @{ File = $p; Kind = 'npm' } }
        }
    }
    return $null
}

$claude = Find-Claude
if ($claude) {
    $ver = try { (& $claude.File --version 2>&1 | Select-Object -First 1) } catch { 'unknown' }
    Write-Ok ("Claude Code found: {0} [{1}] version {2}" -f $claude.File, $claude.Kind, $ver)
} else {
    Write-Warn 'No directly executable Claude Code found (only npx would work).'
}

$shouldInstall = switch ($InstallNative) {
    'always' { $true }
    'never'  { $false }
    default  { $null -eq $claude }
}

if ($shouldInstall -and -not $ReportOnly) {
    Write-Info 'Installing Claude Code natively (official installer, stable channel, no administrator rights).'
    Write-Info 'Source: https://claude.ai/install.ps1  -> installs to %USERPROFILE%\.local\bin\claude.exe'
    try {
        $installerScript = Invoke-RestMethod -Uri 'https://claude.ai/install.ps1' -UseBasicParsing
        & ([scriptblock]::Create($installerScript)) stable
        $claude = Find-Claude
        if ($claude) {
            $ver = try { (& $claude.File --version 2>&1 | Select-Object -First 1) } catch { 'unknown' }
            Write-Ok ("Claude Code installed: {0} version {1}" -f $claude.File, $ver)
        } else {
            Write-Warn 'Installer finished but claude.exe was not found; the host will fall back to npx.'
        }
    } catch {
        Write-Warn ("Native install failed: {0}" -f $_.Exception.Message)
        Write-Warn 'The host will fall back to npx, which still works but is slower and needs network on every launch.'
    }
} elseif ($shouldInstall) {
    Write-Info '(ReportOnly) would install Claude Code natively.'
} else {
    Write-Info "Native install skipped (-InstallNative $InstallNative)."
}

# --------------------------------------------------------------------------
# 4. Look for existing autostart entries (avoid double-launching)
# --------------------------------------------------------------------------
Write-Step '4. Existing autostart / duplicate check'

$ourFullName = ($TaskPath.TrimEnd('\') + '\' + $TaskName)
$foundOther = $false

try {
    $tasks = Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object {
        $execText = ''
        $argText  = ''
        foreach ($a in $_.Actions) {
            if ($a.PSObject.Properties.Name -contains 'Execute')   { $execText += [string]$a.Execute }
            if ($a.PSObject.Properties.Name -contains 'Arguments') { $argText  += [string]$a.Arguments }
        }
        ($_.TaskName -match 'claude|bello') -or ($execText -match 'claude') -or ($argText -match 'claude|BelloClaudeHost')
    }
    foreach ($t in $tasks) {
        $full = ($t.TaskPath.TrimEnd('\') + '\' + $t.TaskName)
        if ($full -eq $ourFullName) {
            Write-Info "Existing task from this installer will be updated in place: $full"
        } else {
            $foundOther = $true
            Write-Warn "Other Claude-related scheduled task found: $full (state: $($t.State))"
        }
    }
    if (-not $tasks) { Write-Ok 'No existing Claude-related scheduled tasks.' }
} catch {
    Write-Warn ("Could not enumerate scheduled tasks: {0}" -f $_.Exception.Message)
}

foreach ($hive in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Run',
                    'HKLM:\Software\Microsoft\Windows\CurrentVersion\Run')) {
    try {
        $props = Get-ItemProperty -Path $hive -ErrorAction SilentlyContinue
        if ($props) {
            foreach ($p in $props.PSObject.Properties) {
                if ($p.Name -like 'PS*') { continue }
                if ("$($p.Name) $($p.Value)" -match 'claude|bello') {
                    $foundOther = $true
                    Write-Warn "Autostart registry entry: $hive\$($p.Name) = $($p.Value)"
                }
            }
        }
    } catch { }
}

foreach ($folder in @([Environment]::GetFolderPath('Startup'), [Environment]::GetFolderPath('CommonStartup'))) {
    if ($folder -and (Test-Path -LiteralPath $folder)) {
        Get-ChildItem -LiteralPath $folder -File -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -match 'claude|bello' } |
            ForEach-Object { $foundOther = $true; Write-Warn "Startup folder entry: $($_.FullName)" }
    }
}

$running = @(Get-Process -Name 'claude' -ErrorAction SilentlyContinue)
if ($running.Count -gt 0) {
    Write-Warn ("{0} claude process(es) already running (pids: {1})." -f $running.Count, (($running | ForEach-Object { $_.Id }) -join ', '))
    Write-Info 'The supervisor uses a named mutex, so it will not start a second BELLO host regardless.'
} else {
    Write-Ok 'No claude process currently running.'
}

if ($foundOther) {
    Write-Warn 'Review the entries above. If any of them also starts Claude Code for this repository, remove it so only one host runs.'
} else {
    Write-Ok 'No conflicting autostart entry found.'
}

# --------------------------------------------------------------------------
# 5. Register the logon scheduled task
# --------------------------------------------------------------------------
Write-Step '5. Scheduled task registration'

# Drive the scheduled task with Windows PowerShell 5.1, which exists on every
# supported Windows build. Using $PSHOME would bind the task to whichever host
# happened to run this installer (PowerShell 7, an IDE-embedded host, ...).
$belloSystemRoot = [string]$env:SystemRoot
if ([string]::IsNullOrWhiteSpace($belloSystemRoot)) { $belloSystemRoot = 'C:\Windows' }
$psExe = Join-Path $belloSystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
if (-not (Test-Path -LiteralPath $psExe)) {
    $psFallback = Get-Command 'powershell.exe' -CommandType Application -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($psFallback) { $psExe = $psFallback.Source }
    elseif (Test-Path -LiteralPath (Join-Path $PSHOME 'pwsh.exe')) { $psExe = Join-Path $PSHOME 'pwsh.exe' }
    else { $psExe = Join-Path $PSHOME 'powershell.exe' }
}
Write-Info "Task host: $psExe"

$windowStyle = if ($Hidden) { 'Hidden' } else { 'Minimized' }
$argLine = '-NoProfile -ExecutionPolicy Bypass -WindowStyle {0} -File "{1}" -ConfigPath "{2}"' -f `
    $windowStyle, $supervisor, $ConfigPath
if ($Hidden) { $argLine += ' -Hidden' }

Write-Info "Action : `"$psExe`" $argLine"

if ($ReportOnly) {
    Write-Info '(ReportOnly) task not registered.'
} else {
    $userId = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

    $action = New-ScheduledTaskAction -Execute $psExe -Argument $argLine -WorkingDirectory $BelloScriptDir

    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $userId
    # Let the network stack settle before the first connection attempt.
    $trigger.Delay = ('PT{0}S' -f $StartDelaySeconds)

    # LogonType Interactive + RunLevel Limited: runs as you, without elevation,
    # and no password is stored anywhere.
    $principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited

    $settings = New-ScheduledTaskSettingsSet `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries `
        -StartWhenAvailable `
        -MultipleInstances IgnoreNew `
        -ExecutionTimeLimit ([TimeSpan]::Zero) `
        -RestartCount 3 `
        -RestartInterval (New-TimeSpan -Minutes 5)
    $settings.IdleSettings.StopOnIdleEnd = $false
    $settings.DisallowStartOnRemoteAppSession = $false

    $registered = $false
    $candidatePaths = @($TaskPath)
    if ($TaskPath -ne '\') { $candidatePaths += '\' }
    foreach ($path in $candidatePaths) {
        try {
            Register-ScheduledTask -TaskName $TaskName -TaskPath $path `
                -Action $action -Trigger $trigger -Principal $principal -Settings $settings `
                -Description 'Starts and supervises the BELLO Claude Code Remote Control host at logon.' `
                -Force | Out-Null
            $ourFullName = ($path.TrimEnd('\') + '\' + $TaskName)
            Write-Ok "Scheduled task registered: $ourFullName"
            Write-Info ('Trigger: at logon of this user, delayed {0}s. Multiple instances: IgnoreNew. Time limit: none.' -f $StartDelaySeconds)
            $registered = $true
            break
        } catch {
            Write-Warn ("Could not register task at '{0}': {1}" -f $path, $_.Exception.Message)
        }
    }
    if (-not $registered) {
        Write-Fail 'Scheduled task registration failed.'
        Write-Action "Run this script from a normal (non-elevated) PowerShell window opened as your own user, or start the host manually with: powershell -ExecutionPolicy Bypass -File `"$supervisor`""
    }
}

# --------------------------------------------------------------------------
# 6. Power / sleep
# --------------------------------------------------------------------------
Write-Step '6. Sleep settings'

try {
    $active = (powercfg /getactivescheme) 2>&1
    Write-Info "Active power plan: $active"
} catch {
    Write-Warn 'Could not query the active power plan.'
}

function Get-SleepTimeoutSeconds {
    param([string] $Setting)  # STANDBYIDLE or HIBERNATEIDLE
    try {
        $out = powercfg /query SCHEME_CURRENT SUB_SLEEP $Setting 2>&1 | Out-String
        if ($out -match 'Current AC Power Setting Index:\s*0x([0-9a-fA-F]+)') {
            return [Convert]::ToInt32($Matches[1], 16)
        }
    } catch { }
    return -1
}

$standbyAc   = Get-SleepTimeoutSeconds -Setting 'STANDBYIDLE'
$hibernateAc = Get-SleepTimeoutSeconds -Setting 'HIBERNATEIDLE'
Write-Info ("Current AC sleep timeout    : {0}" -f $(if ($standbyAc -lt 0) { 'unknown' } elseif ($standbyAc -eq 0) { 'never' } else { "$standbyAc s" }))
Write-Info ("Current AC hibernate timeout: {0}" -f $(if ($hibernateAc -lt 0) { 'unknown' } elseif ($hibernateAc -eq 0) { 'never' } else { "$hibernateAc s" }))
Write-Info 'While the supervisor runs on AC power it already blocks system sleep, without changing any of these settings.'
Write-Info 'The display timeout and the lock screen are never modified by this tool.'

if ($ConfigurePower -and -not $ReportOnly) {
    $backupDir = Join-Path $config.LogRoot 'state'
    if (-not (Test-Path -LiteralPath $backupDir)) { New-Item -ItemType Directory -Path $backupDir -Force | Out-Null }
    $backupFile = Join-Path $backupDir 'powercfg-backup.json'
    if (-not (Test-Path -LiteralPath $backupFile)) {
        @{ standbyTimeoutAcSeconds = $standbyAc; hibernateTimeoutAcSeconds = $hibernateAc; savedAt = (Get-Date).ToString('o') } |
            ConvertTo-Json | Set-Content -LiteralPath $backupFile -Encoding UTF8
        Write-Ok "Previous AC sleep timeouts saved to $backupFile (used by Uninstall-BelloClaudeHost.ps1)."
    }
    $failed = $false
    foreach ($pair in @(@('standby-timeout-ac', '0'), @('hibernate-timeout-ac', '0'))) {
        $out = powercfg /change $pair[0] $pair[1] 2>&1
        if ($LASTEXITCODE -ne 0) {
            $failed = $true
            Write-Warn ("powercfg /change {0} {1} failed: {2}" -f $pair[0], $pair[1], ($out | Out-String).Trim())
        } else {
            Write-Ok ("AC {0} set to never." -f $pair[0])
        }
    }
    if ($failed) {
        Write-Action 'Windows refused the power change without elevation. If you want the permanent setting, open PowerShell as Administrator and run:'
        Write-Action '    powercfg /change standby-timeout-ac 0'
        Write-Action '    powercfg /change hibernate-timeout-ac 0'
        Write-Info 'This is optional. Without it the PC still stays awake while the BELLO host is running.'
    }
} else {
    Write-Info 'Permanent power-plan change not requested (-ConfigurePower). Nothing was modified.'
}

# --------------------------------------------------------------------------
# 7. What you still have to do yourself
# --------------------------------------------------------------------------
Write-Step '7. Steps that require you (they cannot be automated)'

Write-Action "1. Sign in to Claude Code once, from the repository directory:"
Write-Action "     cd `"$($config.RepoPath)`""
Write-Action "     claude          (or: npx.cmd @anthropic-ai/claude-code)"
Write-Action "   then run /login and complete the browser sign-in."
Write-Action "   Remote Control needs a Pro / Max / Team / Enterprise login. API keys are not supported."
Write-Action "2. In that same first run, accept the workspace trust prompt for the repository."
Write-Action "   Remote Control must be started from a trusted project directory."
Write-Info    "Both are one-time. The scheduled task reuses the login afterwards."

Write-Step 'Next'
Write-Info "Verify the setup:  powershell -ExecutionPolicy Bypass -File `"$(Join-Path $BelloScriptDir 'Test-BelloClaudeHost.ps1')`""
Write-Info "Start it now:      powershell -ExecutionPolicy Bypass -File `"$supervisor`""
Write-Info "Check status:      powershell -ExecutionPolicy Bypass -File `"$(Join-Path $BelloScriptDir 'Get-BelloClaudeHostStatus.ps1')`""
Write-Info "Logs:              $(Join-Path $config.LogRoot 'logs')"
Write-Info "Undo everything:   powershell -ExecutionPolicy Bypass -File `"$(Join-Path $BelloScriptDir 'Uninstall-BelloClaudeHost.ps1')`""

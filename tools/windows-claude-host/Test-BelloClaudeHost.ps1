<#
.SYNOPSIS
    Verifies the BELLO Claude Code Remote Control host setup on this PC.

.DESCRIPTION
    Non-destructive checks. Nothing is installed or reconfigured; the only
    things written are files under a throwaway temp directory used by the
    abnormal-exit test.

    Covered:
      1. scripts present and syntactically valid
      2. configuration and repository
      3. Claude Code executable, version and Remote Control support
      4. Remote Control preconditions (login, blocking environment variables)
      5. supervisor dry run + logging
      6. double-start prevention (named mutex)
      7. abnormal-exit handling and the crash-loop guard, end to end
      8. scheduled task registration and its settings
      9. sleep behaviour on AC power

    Add -Live to additionally start the real host for a short while and
    confirm Remote Control connects. That needs you to be signed in.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\Test-BelloClaudeHost.ps1
#>
[CmdletBinding()]
param(
    [string] $ConfigPath = (Join-Path $PSScriptRoot 'bello-claude-host.config.psd1'),
    [string] $TaskName   = 'ClaudeCodeRemoteControl',
    [string] $TaskPath   = '\BELLO\',

    # Also start the real Remote Control host for -LiveSeconds and check it connects.
    [switch] $Live,
    [int]    $LiveSeconds = 90
)

$ErrorActionPreference = 'Continue'

$script:Pass = 0; $script:Fail = 0; $script:Skip = 0
function T-Pass { param([string]$m) $script:Pass++; Write-Host "  [PASS] $m" -ForegroundColor Green }
function T-Fail { param([string]$m) $script:Fail++; Write-Host "  [FAIL] $m" -ForegroundColor Red }
function T-Skip { param([string]$m) $script:Skip++; Write-Host "  [SKIP] $m" -ForegroundColor DarkGray }
function T-Info { param([string]$m) Write-Host "  [info] $m" }
function Section { param([string]$t) Write-Host "`n=== $t ===" -ForegroundColor Cyan }

# --------------------------------------------------------------------------
Section '1. Scripts present and syntactically valid'

$expected = @(
    'Start-BelloClaudeHost.ps1',
    'Install-BelloClaudeHost.ps1',
    'Uninstall-BelloClaudeHost.ps1',
    'Stop-BelloClaudeHost.ps1',
    'Get-BelloClaudeHostStatus.ps1',
    'Test-BelloClaudeHost.ps1',
    'bello-claude-host.config.psd1'
)
foreach ($name in $expected) {
    $p = Join-Path $PSScriptRoot $name
    if (-not (Test-Path -LiteralPath $p)) { T-Fail "missing: $name"; continue }
    if ($name -like '*.ps1') {
        $errors = $null; $tokens = $null
        [void][System.Management.Automation.Language.Parser]::ParseFile($p, [ref]$tokens, [ref]$errors)
        if ($errors -and $errors.Count) { T-Fail "$name has $($errors.Count) syntax error(s): $($errors[0].Message)" }
        else { T-Pass "$name parses cleanly" }
    } else {
        T-Pass "$name present"
    }
}

$supervisor = Join-Path $PSScriptRoot 'Start-BelloClaudeHost.ps1'

# --------------------------------------------------------------------------
Section '2. Configuration and repository'

$config = $null
try {
    $config = Import-PowerShellDataFile -LiteralPath $ConfigPath
    T-Pass "config loads: $ConfigPath"
} catch {
    T-Fail ("config does not load: {0}" -f $_.Exception.Message)
}

$logRoot = Join-Path $env:LOCALAPPDATA 'BELLO\claude-host'
if ($config) {
    if (-not [string]::IsNullOrWhiteSpace($config.LogRoot)) { $logRoot = $config.LogRoot }
    if (Test-Path -LiteralPath $config.RepoPath) {
        T-Pass "repository exists: $($config.RepoPath)"
        if (Test-Path -LiteralPath (Join-Path $config.RepoPath '.git')) { T-Pass 'repository is a git working tree' }
        else { T-Fail 'repository is not a git working tree' }
    } else {
        T-Fail "repository not found: $($config.RepoPath)"
    }
    T-Info "session name: $($config.SessionName)"
    T-Info ("crash-loop guard: max {0} restarts within {1} minutes" -f $config.MaxRestarts, $config.CrashWindowMinutes)
}
T-Info "log root: $logRoot"

# --------------------------------------------------------------------------
Section '3. Claude Code executable'

function Find-Claude {
    $c = Get-Command -Name 'claude' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($c) { return @{ File = $c.Source; Kind = 'path' } }
    $native = Join-Path $env:USERPROFILE '.local\bin\claude.exe'
    if (Test-Path -LiteralPath $native) { return @{ File = $native; Kind = 'native' } }
    foreach ($leaf in @('claude.cmd', 'claude.exe')) {
        $p = Join-Path $env:APPDATA ('npm\' + $leaf)
        if (Test-Path -LiteralPath $p) { return @{ File = $p; Kind = 'npm' } }
    }
    $npx = Get-Command -Name 'npx.cmd' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($npx) { return @{ File = $npx.Source; Kind = 'npx' } }
    return $null
}

$claude = Find-Claude
if ($null -eq $claude) {
    T-Fail 'Claude Code not found by any method (PATH, native, npm global, npx)'
} else {
    T-Pass "Claude Code resolved: $($claude.File) [$($claude.Kind)]"
    if ($claude.Kind -eq 'npx') {
        T-Info 'Using the npx fallback. Re-run Install-BelloClaudeHost.ps1 -InstallNative always for a faster, more reliable launcher.'
    }
    $helpText = ''
    try {
        if ($claude.Kind -eq 'npx') {
            $ver = & $claude.File --yes '@anthropic-ai/claude-code' --version 2>&1 | Select-Object -First 1
            $helpText = (& $claude.File --yes '@anthropic-ai/claude-code' --help 2>&1 | Out-String)
        } else {
            $ver = & $claude.File --version 2>&1 | Select-Object -First 1
            $helpText = (& $claude.File --help 2>&1 | Out-String)
        }
        T-Pass "version: $ver"
    } catch {
        T-Fail ("could not run Claude Code: {0}" -f $_.Exception.Message)
    }
    if ($helpText -match '--remote-control') { T-Pass 'this build supports Remote Control (--remote-control present in --help)' }
    elseif ($helpText) { T-Fail 'this build does not list --remote-control; update Claude Code' }
    if ($helpText -match '(?m)^\s+remote-control') { T-Pass 'server mode subcommand `claude remote-control` is available' }
    elseif ($helpText) { T-Info 'server-mode subcommand not listed in top-level help (it is still accepted); the host uses `claude remote-control`' }
}

# --------------------------------------------------------------------------
Section '4. Remote Control preconditions'

if ($claude -and $claude.Kind -ne 'npx') {
    try {
        $authOut = (& $claude.File auth status 2>&1 | Out-String).Trim()
        T-Info "claude auth status: $authOut"
        if ($authOut -match 'not logged in|not authenticated|no credentials|Logged out') {
            T-Fail 'not signed in - Remote Control cannot start. Run `claude` in the repository and use /login.'
        } else {
            T-Pass 'an authentication record is present'
        }
    } catch {
        T-Skip ("could not read auth status: {0}" -f $_.Exception.Message)
    }
} else {
    T-Skip 'auth status check (needs a directly executable claude)'
}

$blockers = @('DISABLE_TELEMETRY', 'DO_NOT_TRACK', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', 'DISABLE_GROWTHBOOK')
$anyBlocker = $false
foreach ($name in $blockers) {
    $v = [Environment]::GetEnvironmentVariable($name)
    if (-not [string]::IsNullOrWhiteSpace($v)) { $anyBlocker = $true; T-Fail "$name=$v is set; it disables the feature-flag evaluation Remote Control needs" }
}
if (-not $anyBlocker) { T-Pass 'no Remote-Control-blocking environment variables set' }

$baseUrl = [Environment]::GetEnvironmentVariable('ANTHROPIC_BASE_URL')
if (-not [string]::IsNullOrWhiteSpace($baseUrl) -and $baseUrl -notmatch 'api\.anthropic\.com') {
    T-Fail "ANTHROPIC_BASE_URL=$baseUrl points away from api.anthropic.com; Remote Control is unavailable"
} else { T-Pass 'ANTHROPIC_BASE_URL is unset or points at api.anthropic.com' }

# --------------------------------------------------------------------------
Section '5. Supervisor dry run and logging'

$logDir = Join-Path $logRoot 'logs'
$before = @(Get-ChildItem -LiteralPath $logDir -Filter 'supervisor-*.log' -ErrorAction SilentlyContinue).Count
$dry = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $supervisor -ConfigPath $ConfigPath -WhatIfLaunch 2>&1 | Out-String
$dryExit = $LASTEXITCODE
if ($dryExit -eq 0 -and $dry -match 'WhatIfLaunch specified') {
    T-Pass "supervisor dry run succeeded (exit $dryExit)"
} else {
    T-Fail "supervisor dry run failed (exit $dryExit)"
    Write-Host $dry
}
if ($dry -match 'Launch command\s*:\s*(.+)') { T-Info ("would run: " + $Matches[1].Trim()) }

$latest = Get-ChildItem -LiteralPath $logDir -Filter 'supervisor-*.log' -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($latest -and (Get-Content -LiteralPath $latest.FullName -Raw) -match 'BELLO Claude Code host starting') {
    T-Pass "lifecycle log written: $($latest.FullName)"
} else {
    T-Fail "no supervisor log found under $logDir"
}

# --------------------------------------------------------------------------
Section '6. Double-start prevention'

$probe = New-Object System.Threading.Mutex($false, 'Local\BELLO-ClaudeCodeHost')
$held = $false
try { $held = $probe.WaitOne(0) } catch { $held = $false }

if (-not $held) {
    T-Info 'The host mutex is already held, which means a BELLO host is running right now.'
    $second = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $supervisor -ConfigPath $ConfigPath -WhatIfLaunch 2>&1 | Out-String
    if ($second -match 'already running') { T-Pass 'a second host refuses to start while one is running' }
    else { T-Fail 'a second host was NOT blocked' }
} else {
    try {
        $second = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $supervisor -ConfigPath $ConfigPath -WhatIfLaunch 2>&1 | Out-String
        $secondExit = $LASTEXITCODE
        if ($second -match 'already running' -and $secondExit -eq 0) {
            T-Pass 'a second host detects the lock, logs it and exits 0 (no double launch)'
        } else {
            T-Fail "second host was not blocked by the mutex (exit $secondExit)"
            Write-Host $second
        }
    } finally {
        $probe.ReleaseMutex()
    }
}
$probe.Dispose()

# --------------------------------------------------------------------------
Section '7. Abnormal exit and crash-loop guard (end to end, isolated)'

$sandbox = Join-Path $env:TEMP ('bello-host-test-' + [Guid]::NewGuid().ToString('N').Substring(0, 8))
try {
    $fakeBin  = Join-Path $sandbox 'bin'
    $fakeRepo = Join-Path $sandbox 'repo'
    $fakeLogs = Join-Path $sandbox 'logroot'
    foreach ($d in @($sandbox, $fakeBin, $fakeRepo, (Join-Path $fakeRepo '.git'), $fakeLogs)) {
        New-Item -ItemType Directory -Path $d -Force | Out-Null
    }

    # A stand-in for claude that always fails, so the guard can be observed.
    # Written as an array so Set-Content uses native CRLF line endings,
    # which cmd.exe requires regardless of how this repo was checked out.
    @(
        '@echo off',
        'if "%1"=="--version" ( echo 0.0.0 test-stub & exit /b 0 )',
        'echo simulated Claude Code failure',
        'exit /b 7'
    ) | Set-Content -LiteralPath (Join-Path $fakeBin 'claude.cmd') -Encoding ASCII

    $fakeConfig = Join-Path $sandbox 'test.config.psd1'
    @"
@{
    RepoPath = '$fakeRepo'
    SessionName = 'BELLO-selftest'
    LogRoot = '$fakeLogs'
    MaxRestarts = 3
    CrashWindowMinutes = 10
    HealthySeconds = 120
    BaseBackoffSeconds = 1
    MaxBackoffSeconds = 2
    InhibitSleepOnAC = `$false
    LogRetentionDays = 1
}
"@ | Set-Content -LiteralPath $fakeConfig -Encoding UTF8

    $savedPath = $env:PATH
    $env:PATH = "$fakeBin;$savedPath"
    try {
        $crashOut = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $supervisor -ConfigPath $fakeConfig 2>&1 | Out-String
        $crashExit = $LASTEXITCODE
    } finally {
        $env:PATH = $savedPath
    }

    if ($crashOut -match 'Restarting in 1s')  { T-Pass 'restarts after an abnormal exit' } else { T-Fail 'did not restart after an abnormal exit' }
    if ($crashOut -match 'Restarting in 2s')  { T-Pass 'backoff grows between restarts' } else { T-Fail 'backoff did not grow' }
    if ($crashOut -match 'Stopping to avoid a restart loop') { T-Pass 'crash-loop guard stops the host instead of looping forever' } else { T-Fail 'crash-loop guard did not fire' }
    if ($crashExit -eq 4) { T-Pass "gave up with the documented exit code 4" } else { T-Fail "unexpected exit code $crashExit (expected 4)" }

    $selfLog = Get-ChildItem -LiteralPath (Join-Path $fakeLogs 'logs') -Filter 'supervisor-*.log' -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($selfLog -and (Get-Content -LiteralPath $selfLog.FullName -Raw) -match 'FATAL') {
        T-Pass 'the give-up reason is recorded in the log file'
    } else { T-Fail 'the crash-loop reason was not written to a log file' }

    $selfState = Join-Path $fakeLogs 'state\state.json'
    if ((Test-Path -LiteralPath $selfState) -and ((Get-Content -LiteralPath $selfState -Raw) -match 'crash-loop-stopped')) {
        T-Pass 'state.json records status=crash-loop-stopped'
    } else { T-Fail 'state.json does not record the crash-loop stop' }
} finally {
    Remove-Item -LiteralPath $sandbox -Recurse -Force -ErrorAction SilentlyContinue
}

# --------------------------------------------------------------------------
Section '8. Logon autostart (scheduled task)'

$task = $null
foreach ($p in @($TaskPath, '\')) {
    $task = Get-ScheduledTask -TaskName $TaskName -TaskPath $p -ErrorAction SilentlyContinue
    if ($task) { break }
}
if (-not $task) {
    T-Fail "scheduled task '$TaskName' is not registered. Run Install-BelloClaudeHost.ps1."
} else {
    T-Pass "task registered: $($task.TaskPath)$($task.TaskName) (state: $($task.State))"

    $logonTrigger = @($task.Triggers | Where-Object { $_.CimClass.CimClassName -eq 'MSFT_TaskLogonTrigger' })
    if ($logonTrigger.Count -ge 1) { T-Pass "starts at logon (delay: $($logonTrigger[0].Delay))" }
    else { T-Fail 'no logon trigger on the task' }

    if ($task.Settings.MultipleInstances -eq 'IgnoreNew') { T-Pass 'MultipleInstances=IgnoreNew (Task Scheduler will not launch a duplicate)' }
    else { T-Fail "MultipleInstances is $($task.Settings.MultipleInstances); expected IgnoreNew" }

    if ($task.Settings.ExecutionTimeLimit -in @('PT0S', 'PT0H0M0S')) { T-Pass 'no execution time limit (the host may run indefinitely)' }
    else { T-Fail "ExecutionTimeLimit is $($task.Settings.ExecutionTimeLimit); expected none" }

    if (-not $task.Settings.DisallowStartIfOnBatteries) { T-Pass 'allowed to start on battery' } else { T-Fail 'will not start on battery' }
    if (-not $task.Settings.StopIfGoingOnBatteries) { T-Pass 'not stopped when switching to battery' } else { T-Fail 'stops when switching to battery' }
    if ($task.Settings.RestartCount -ge 1) { T-Pass "Task Scheduler also retries $($task.Settings.RestartCount)x if the task itself fails" }

    if ($task.Principal.RunLevel -eq 'Limited') { T-Pass 'runs without elevation (RunLevel=Limited)' }
    else { T-Fail "RunLevel is $($task.Principal.RunLevel); expected Limited" }
    if ($task.Principal.LogonType -eq 'Interactive') { T-Pass 'LogonType=Interactive (no stored password)' }
    else { T-Info "LogonType is $($task.Principal.LogonType)" }

    $act = @($task.Actions)[0]
    T-Info "action: $($act.Execute) $($act.Arguments)"
    if ($act.Arguments -match [regex]::Escape($supervisor)) { T-Pass 'task points at this supervisor script' }
    else { T-Fail 'task points at a different script' }

    $info = Get-ScheduledTaskInfo -TaskName $task.TaskName -TaskPath $task.TaskPath -ErrorAction SilentlyContinue
    if ($info) { T-Info ("last run: {0}, last result: 0x{1:X}" -f $info.LastRunTime, $info.LastTaskResult) }
}

# --------------------------------------------------------------------------
Section '9. Sleep behaviour on AC power'

try {
    $batteries = @(Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue)
    if ($batteries.Count -eq 0) { T-Info 'no battery present (desktop): always treated as AC power' }
    else {
        foreach ($b in $batteries) {
            $state = if ($b.BatteryStatus -ne 1) { 'on AC' } else { 'on battery' }
            T-Info ("battery status {0} => {1}, charge {2}%" -f $b.BatteryStatus, $state, $b.EstimatedChargeRemaining)
        }
    }
} catch { T-Skip 'battery state unavailable' }

try {
    if (-not ('Bello.PowerUtilTest' -as [type])) {
        Add-Type -Namespace 'Bello' -Name 'PowerUtilTest' -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true)]
public static extern uint SetThreadExecutionState(uint esFlags);
'@
    }
    $ES_CONTINUOUS = [uint32]'0x80000000'
    $ES_SYSTEM_REQUIRED = [uint32]'0x00000001'
    $prev = [Bello.PowerUtilTest]::SetThreadExecutionState($ES_CONTINUOUS -bor $ES_SYSTEM_REQUIRED)
    [void][Bello.PowerUtilTest]::SetThreadExecutionState($ES_CONTINUOUS)
    if ($prev -ne 0) { T-Pass 'the no-system-sleep request works on this PC (asserted and released)' }
    else { T-Fail 'SetThreadExecutionState returned 0' }
} catch {
    T-Fail ("sleep inhibition unavailable: {0}" -f $_.Exception.Message)
}

function Get-AcTimeout { param([string]$Setting)
    $out = powercfg /query SCHEME_CURRENT SUB_SLEEP $Setting 2>&1 | Out-String
    if ($out -match 'Current AC Power Setting Index:\s*0x([0-9a-fA-F]+)') { return [Convert]::ToInt32($Matches[1], 16) }
    return -1
}
$sb = Get-AcTimeout -Setting 'STANDBYIDLE'
T-Info ("power plan AC sleep timeout: {0}" -f $(if ($sb -lt 0) { 'unknown' } elseif ($sb -eq 0) { 'never' } else { "$sb s" }))
$mon = powercfg /query SCHEME_CURRENT SUB_VIDEO VIDEOIDLE 2>&1 | Out-String
if ($mon -match 'Current AC Power Setting Index:\s*0x([0-9a-fA-F]+)') {
    $m = [Convert]::ToInt32($Matches[1], 16)
    T-Info ("power plan AC display timeout: {0} (deliberately left alone; the screen still turns off and locks)" -f $(if ($m -eq 0) { 'never' } else { "$m s" }))
}
if ($sb -eq 0) { T-Pass 'the PC never sleeps on AC in the power plan' }
else { T-Info 'The power plan still sleeps on AC, but the supervisor blocks sleep while the host runs. Use Install-BelloClaudeHost.ps1 -ConfigurePower to make it permanent.' }

# --------------------------------------------------------------------------
if ($Live) {
    Section "10. Live Remote Control start ($LiveSeconds s)"
    $liveLogBefore = Get-ChildItem -LiteralPath (Join-Path $logRoot 'logs') -Filter 'supervisor-*.log' -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
    $offset = if ($liveLogBefore) { (Get-Content -LiteralPath $liveLogBefore.FullName).Count } else { 0 }

    $p = Start-Process -FilePath 'powershell.exe' `
        -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $supervisor, '-ConfigPath', $ConfigPath) `
        -PassThru -WindowStyle Minimized
    T-Info "host started as pid $($p.Id); waiting $LiveSeconds s ..."
    Start-Sleep -Seconds $LiveSeconds

    & (Join-Path $PSScriptRoot 'Stop-BelloClaudeHost.ps1') -ConfigPath $ConfigPath | Out-Null
    $deadline = (Get-Date).AddSeconds(60)
    while (-not $p.HasExited -and (Get-Date) -lt $deadline) { Start-Sleep -Seconds 3 }
    if (-not $p.HasExited) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }

    $liveLog = Get-ChildItem -LiteralPath (Join-Path $logRoot 'logs') -Filter 'supervisor-*.log' -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
    $tail = (Get-Content -LiteralPath $liveLog.FullName | Select-Object -Skip $offset) -join "`n"
    if ($tail -match 'Claude Code running as pid') { T-Pass 'the Remote Control server process started' }
    else { T-Fail 'the server never reported a running process'; Write-Host $tail }
    if ($tail -match 'Stopping to avoid a restart loop') {
        T-Fail 'the server kept failing - check the Claude debug log named above (usually: not signed in, or workspace trust not accepted)'
    }
    T-Info 'Open claude.ai/code (or the Claude mobile app) and confirm the session appears with a green dot.'
}

# --------------------------------------------------------------------------
Write-Host "`n=== Result ===" -ForegroundColor Cyan
Write-Host ("  Passed: {0}   Failed: {1}   Skipped: {2}" -f $script:Pass, $script:Fail, $script:Skip)
if ($script:Fail -eq 0) {
    Write-Host '  All checks passed.' -ForegroundColor Green
    exit 0
} else {
    Write-Host '  Some checks failed - see [FAIL] lines above.' -ForegroundColor Red
    exit 1
}

<#
.SYNOPSIS
    BELLO Dev Orchestrator の監督プロセス (指示書 §11)。

.DESCRIPTION
    Node で書かれた Orchestrator を起動し、落ちたら指数バックオフで再起動する。
    設計は tools/windows-claude-host の Remote Control ホストと同じで、
    2026-09-03 に実機で復旧を実測した方式をそのまま踏襲している:

      * 名前付き Mutex による単一起動保証 (+ タスク側 MultipleInstances=IgnoreNew)
      * 停止フラグによる意図的な停止 (ウォッチドッグが打ち消さない)
      * 10 分に 5 回で crash-loop を止め、クールダウン中はウォッチドッグを待機させる
      * コンソール消失を検知したら自分から退場し、ウォッチドッグに任せる
      * AC 電源時のみシステムスリープを抑止 (画面とロックには触らない)

    管理者権限は不要。認証情報は一切扱わない。

.NOTES
    Windows PowerShell 5.1 / PowerShell 7 の両方で動く書き方にしてある。
#>
[CmdletBinding()]
param(
    [string] $ConfigPath,
    [switch] $Once,
    [switch] $NoSleepInhibit,
    # スケジューラのウォッチドッグから起動された (人間の手動起動ではない)
    [switch] $Watchdog
)

# --- スクリプト位置の解決 (5.1 安全) ---------------------------------------
$BelloScriptDir = ''
if (-not [string]::IsNullOrWhiteSpace($PSScriptRoot)) { $BelloScriptDir = $PSScriptRoot }
if ([string]::IsNullOrWhiteSpace($BelloScriptDir) -and -not [string]::IsNullOrWhiteSpace($PSCommandPath)) {
    $BelloScriptDir = Split-Path -Parent $PSCommandPath
}
if ([string]::IsNullOrWhiteSpace($BelloScriptDir)) { $BelloScriptDir = (Get-Location).ProviderPath }
if ([string]::IsNullOrWhiteSpace($ConfigPath)) {
    $ConfigPath = Join-Path $BelloScriptDir 'bello-orchestrator.config.json'
}

$ErrorActionPreference = 'Stop'

# --- 設定の読み取り (非秘密のみ) --------------------------------------------
$dataRoot = ''
try {
    $raw = Get-Content -LiteralPath $ConfigPath -Raw -ErrorAction Stop
    $cfg = $raw | ConvertFrom-Json
    if ($cfg.PSObject.Properties['dataRoot'] -and -not [string]::IsNullOrWhiteSpace($cfg.dataRoot)) {
        $dataRoot = $cfg.dataRoot
    }
} catch {
    Write-Warning ("設定ファイルを読めません ({0}): {1}" -f $ConfigPath, $_.Exception.Message)
}
if ([string]::IsNullOrWhiteSpace($dataRoot)) {
    $localAppData = [string]$env:LOCALAPPDATA
    if ([string]::IsNullOrWhiteSpace($localAppData)) {
        $localAppData = [Environment]::GetFolderPath('LocalApplicationData')
    }
    $dataRoot = Join-Path $localAppData 'BELLO\dev-orchestrator'
}

$logDir        = Join-Path $dataRoot 'logs'
$stateDir      = Join-Path $dataRoot 'state'
$pidPath       = Join-Path $stateDir 'supervisor.pid'
$stopFlag      = Join-Path $stateDir 'stop.flag'
$stopAck       = Join-Path $stateDir 'stop.flag.ack'
$crashLoopFlag = Join-Path $stateDir 'crashloop.flag'
$crashLoopAck  = Join-Path $stateDir 'crashloop.flag.ack'
# Orchestrator (Node) 自身が書く PID ファイル。監督プロセスだけが死んだ場合に
# 生き残った Orchestrator を「引き継ぐ」ために読む。
$orchestratorPidPath = Join-Path $stateDir 'orchestrator.pid'

foreach ($dir in @($dataRoot, $logDir, $stateDir)) {
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
}

$script:LogFile     = Join-Path $logDir ('supervisor-{0}.log' -f (Get-Date -Format 'yyyyMMdd'))
$script:QuietExit   = $false
$script:ConsoleLost = $false

# --- 監督パラメータ ---------------------------------------------------------
$MaxRestarts              = 5
$CrashWindowMinutes       = 10
$CrashLoopCooldownMinutes = 30
$HealthySeconds           = 120
$BaseBackoffSeconds       = 5
$MaxBackoffSeconds        = 300

function Write-HostLog {
    param(
        [Parameter(Mandatory)][string] $Message,
        [ValidateSet('INFO', 'WARN', 'ERROR', 'FATAL', 'START', 'STOP')]
        [string] $Level = 'INFO'
    )
    $line = '{0} [{1,-5}] (pid {2}) {3}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss.fff'), $Level, $PID, $Message
    try { Add-Content -LiteralPath $script:LogFile -Value $line -Encoding UTF8 } catch { }
    try {
        switch ($Level) {
            'ERROR' { Write-Host $line -ForegroundColor Red }
            'FATAL' { Write-Host $line -ForegroundColor Red }
            'WARN'  { Write-Host $line -ForegroundColor Yellow }
            'START' { Write-Host $line -ForegroundColor Green }
            'STOP'  { Write-Host $line -ForegroundColor Cyan }
            default { Write-Host $line }
        }
    } catch {
        # コンソールが消えた。ファイルログが残っていれば十分なので、これを
        # 監督プロセスの失敗として扱わない。代わりに退場の合図にする。
        $script:ConsoleLost = $true
    }
}

function Write-QuietOnce {
    param(
        [Parameter(Mandatory)][string] $Marker,
        [string] $Source,
        [Parameter(Mandatory)][string] $Message,
        [ValidateSet('INFO', 'WARN', 'ERROR', 'FATAL', 'START', 'STOP')]
        [string] $Level = 'INFO'
    )
    $shouldLog = $true
    try {
        if (Test-Path -LiteralPath $Marker) {
            $markerTime = (Get-Item -LiteralPath $Marker).LastWriteTime
            $sourceTime = [datetime]::MinValue
            if ((-not [string]::IsNullOrWhiteSpace($Source)) -and (Test-Path -LiteralPath $Source)) {
                $sourceTime = (Get-Item -LiteralPath $Source).LastWriteTime
            }
            if ($markerTime -ge $sourceTime) { $shouldLog = $false }
        }
    } catch { }
    if ($shouldLog) {
        Write-HostLog -Level $Level -Message $Message
        try { Set-Content -LiteralPath $Marker -Value ((Get-Date).ToString('o')) -Encoding UTF8 } catch { }
    }
}

# --- スリープ抑止 (実行中のみ、AC 電源時のみ) --------------------------------
$script:SleepApiReady = $false
function Initialize-PowerApi {
    if ($script:SleepApiReady) { return $true }
    try {
        if (-not ('BelloOrchestratorPower' -as [type])) {
            Add-Type -Namespace 'Bello' -Name 'OrchestratorPower' -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true)]
public static extern uint SetThreadExecutionState(uint esFlags);
'@ | Out-Null
        }
        $script:SleepApiReady = $true
    } catch {
        Write-HostLog -Level WARN -Message ("スリープ抑止 API を初期化できません: {0}" -f $_.Exception.Message)
        $script:SleepApiReady = $false
    }
    return $script:SleepApiReady
}

function Set-SleepInhibition {
    param([bool] $Enable)
    if ($NoSleepInhibit) { return }
    if (-not (Initialize-PowerApi)) { return }
    try {
        # ES_CONTINUOUS(0x80000000) | ES_SYSTEM_REQUIRED(0x00000001)
        # 画面は意図的に対象外 (ES_DISPLAY_REQUIRED を立てない)
        $flags = if ($Enable) { [uint32]2147483649 } else { [uint32]2147483648 }
        [void][Bello.OrchestratorPower]::SetThreadExecutionState($flags)
        if ($Enable) {
            Write-HostLog -Message 'システムスリープを抑止しました (画面のオフとロックはそのまま)。'
        } else {
            Write-HostLog -Message 'システムスリープの抑止を解除しました。'
        }
    } catch {
        Write-HostLog -Level WARN -Message ("スリープ抑止を変更できません: {0}" -f $_.Exception.Message)
    }
}

function Get-RunningOrchestrator {
    # 監督プロセスだけが強制終了された場合、Orchestrator (Node) は生き残る。
    # 新しい監督プロセスはそれを殺して作り直すのではなく引き継ぐ。実行中の
    # Claude タスクは 1 時間かかることもあり、捨てる方が損害が大きいため。
    # ここへ来る時点で Mutex を保持している = 他に監督プロセスは居ない。
    if (-not (Test-Path -LiteralPath $orchestratorPidPath)) { return $null }
    $text = ''
    try { $text = (Get-Content -LiteralPath $orchestratorPidPath -Raw).Trim() } catch { return $null }
    $opid = 0
    if (-not [int]::TryParse($text, [ref]$opid)) { return $null }
    $proc = Get-Process -Id $opid -ErrorAction SilentlyContinue
    if (-not $proc) { return $null }
    if ($proc.ProcessName -ne 'node') { return $null }   # PID 再利用の誤認を避ける
    return $proc
}

function Resolve-NodeExe {
    $cmd = Get-Command 'node.exe' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($cmd) { return $cmd.Source }
    foreach ($candidate in @(
            (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
            (Join-Path ${env:ProgramFiles(x86)} 'nodejs\node.exe'))) {
        if ($candidate -and (Test-Path -LiteralPath $candidate)) { return $candidate }
    }
    return $null
}

$mutex        = $null
$mutexOwned   = $false
$exitCode     = 0
$failureTimes = New-Object System.Collections.ArrayList

try {
    # ---- 単一起動 ---------------------------------------------------------
    $mutex = New-Object System.Threading.Mutex($false, 'Local\BELLO-DevOrchestrator')
    try { $mutexOwned = $mutex.WaitOne(0) }
    catch [System.Threading.AbandonedMutexException] { $mutexOwned = $true }

    if (-not $mutexOwned) {
        if ($Watchdog) { $script:QuietExit = $true; exit 0 }
        $other = 'unknown'
        if (Test-Path -LiteralPath $pidPath) { $other = (Get-Content -LiteralPath $pidPath -Raw).Trim() }
        Write-HostLog -Level WARN -Message ("Orchestrator は既に起動しています (pid {0})。二重起動はしません。" -f $other)
        exit 0
    }

    # ---- 意図的な停止 / crash-loop クールダウン ---------------------------
    if ($Watchdog) {
        if (Test-Path -LiteralPath $stopFlag) {
            Write-QuietOnce -Marker $stopAck -Source $stopFlag -Message '停止フラグがあるため、ウォッチドッグは待機します。再開するには bello.ps1 start を実行してください。'
            $script:QuietExit = $true
            exit 0
        }
        if (Test-Path -LiteralPath $crashLoopFlag) {
            $cooldownEnd = (Get-Item -LiteralPath $crashLoopFlag).LastWriteTime.AddMinutes($CrashLoopCooldownMinutes)
            if ((Get-Date) -lt $cooldownEnd) {
                Write-QuietOnce -Marker $crashLoopAck -Source $crashLoopFlag -Level WARN -Message ('crash-loop クールダウン中です ({0} まで)。原因を直してから bello.ps1 start を実行してください。' -f $cooldownEnd.ToString('yyyy-MM-dd HH:mm:ss'))
                $script:QuietExit = $true
                exit 0
            }
            Remove-Item -LiteralPath $crashLoopFlag, $crashLoopAck -Force -ErrorAction SilentlyContinue
        }
    } else {
        foreach ($marker in @($stopFlag, $stopAck, $crashLoopFlag, $crashLoopAck)) {
            if (Test-Path -LiteralPath $marker) { Remove-Item -LiteralPath $marker -Force -ErrorAction SilentlyContinue }
        }
    }

    Set-Content -LiteralPath $pidPath -Value $PID -Encoding ASCII

    Write-HostLog -Level START -Message '=== BELLO Dev Orchestrator 監督プロセス 開始 ==='
    Write-HostLog -Message ('ホスト        : {0} / {1}' -f $env:COMPUTERNAME, $env:USERNAME)
    Write-HostLog -Message ('PowerShell    : {0}' -f $PSVersionTable.PSVersion)
    Write-HostLog -Message ('設定          : {0}' -f $ConfigPath)
    Write-HostLog -Message ('データ置き場  : {0}' -f $dataRoot)

    $nodeExe = Resolve-NodeExe
    if (-not $nodeExe) {
        Write-HostLog -Level FATAL -Message 'node.exe が見つかりません。Node.js 22.5 以降をインストールしてください。'
        exit 3
    }
    $nodeVersion = (& $nodeExe --version) 2>&1
    Write-HostLog -Message ('Node.js       : {0} ({1})' -f $nodeVersion, $nodeExe)

    $cli = Join-Path $BelloScriptDir 'src\cli.mjs'
    if (-not (Test-Path -LiteralPath $cli)) {
        Write-HostLog -Level FATAL -Message ("cli.mjs が見つかりません: {0}" -f $cli)
        exit 3
    }

    Set-SleepInhibition -Enable $true

    $attempt = 0
    while ($true) {
        if (Test-Path -LiteralPath $stopFlag) {
            Write-HostLog -Level STOP -Message '停止フラグがあるため起動しません。'
            break
        }

        $attempt++
        $startedAt = Get-Date

        $proc = $null
        $adopted = $null
        if ($attempt -eq 1) { $adopted = Get-RunningOrchestrator }

        if ($null -ne $adopted) {
            Write-HostLog -Level START -Message ('稼働中の Orchestrator (pid {0}) を引き継ぎます。作り直しはしません。' -f $adopted.Id)
            $proc = $adopted
            try { $startedAt = $adopted.StartTime } catch { }
        } else {
            Write-HostLog -Level START -Message ('Orchestrator を起動します (試行 {0})' -f $attempt)
            try {
                $proc = Start-Process -FilePath $nodeExe `
                    -ArgumentList @($cli, 'start', '--watchdog') `
                    -WorkingDirectory $BelloScriptDir -PassThru -NoNewWindow
            } catch {
                Write-HostLog -Level ERROR -Message ("Orchestrator を起動できません: {0}" -f $_.Exception.Message)
            }
        }

        if ($null -ne $proc) {
            Write-HostLog -Message ('Orchestrator は pid {0} で動作中です。ダッシュボードは設定の host:port を参照してください。' -f $proc.Id)
            while (-not $proc.HasExited) {
                [void]$proc.WaitForExit(15000)
                if ($proc.HasExited) { break }
                if (Test-Path -LiteralPath $stopFlag) {
                    Write-HostLog -Level STOP -Message '停止フラグを検出しました。Orchestrator の安全停止を待ちます。'
                    # Orchestrator 自身が stop.flag を見て終了する。強制終了はしない。
                    [void]$proc.WaitForExit(60000)
                    if (-not $proc.HasExited) {
                        Write-HostLog -Level WARN -Message '60 秒で終了しなかったため停止させます。'
                        try { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } catch { }
                    }
                    break
                }
            }
        }

        $ranSeconds = [int]((Get-Date) - $startedAt).TotalSeconds
        $childExit  = 1
        if ($null -ne $proc) {
            try { if ($proc.HasExited -and $null -ne $proc.ExitCode) { $childExit = [int]$proc.ExitCode } } catch { }
        }
        Write-HostLog -Level STOP -Message ('Orchestrator は終了コード {0} で終了しました ({1} 秒)。' -f $childExit, $ranSeconds)

        if ($script:ConsoleLost) {
            Write-HostLog -Level ERROR -Message 'この監督プロセスのコンソールが失われました。ウォッチドッグに任せて退場します。'
            $exitCode = 6
            break
        }
        if (Test-Path -LiteralPath $stopFlag) {
            Write-HostLog -Level STOP -Message '意図的な停止です。再起動しません。'
            break
        }
        if ($Once) { $exitCode = $childExit; break }
        if ($childExit -eq 0) {
            Write-HostLog -Level STOP -Message '正常終了 (0) のため再起動しません。'
            break
        }

        if ($ranSeconds -ge $HealthySeconds) {
            if ($failureTimes.Count -gt 0) {
                Write-HostLog -Message ('前回は {0} 秒動作したため、失敗カウンタを戻します。' -f $ranSeconds)
            }
            $failureTimes.Clear()
            Remove-Item -LiteralPath $crashLoopFlag, $crashLoopAck -Force -ErrorAction SilentlyContinue
        }

        [void]$failureTimes.Add((Get-Date))
        $windowStart = (Get-Date).AddMinutes(-$CrashWindowMinutes)
        $recent = @($failureTimes | Where-Object { $_ -ge $windowStart })
        $failureTimes.Clear()
        foreach ($t in $recent) { [void]$failureTimes.Add($t) }

        if ($failureTimes.Count -ge $MaxRestarts) {
            Write-HostLog -Level FATAL -Message ('{0} 分以内に {1} 回失敗しました (最終終了コード {2})。再起動ループを避けるため停止します。ログ: {3}' -f $CrashWindowMinutes, $failureTimes.Count, $childExit, $script:LogFile)
            Write-HostLog -Level FATAL -Message 'よくある原因: Node の未導入、設定ファイルの不備、データ置き場への書き込み不可。bello.ps1 diagnose を実行してください。'
            try {
                Set-Content -LiteralPath $crashLoopFlag -Value ((Get-Date).ToString('o')) -Encoding UTF8
                Remove-Item -LiteralPath $crashLoopAck -Force -ErrorAction SilentlyContinue
                Write-HostLog -Level WARN -Message ('ウォッチドッグを {0} 分間待機させます。' -f $CrashLoopCooldownMinutes)
            } catch { }
            $exitCode = 4
            break
        }

        $backoff = [int][Math]::Min($BaseBackoffSeconds * [Math]::Pow(2, $failureTimes.Count - 1), $MaxBackoffSeconds)
        Write-HostLog -Level WARN -Message ('{0} 秒後に再起動します (失敗 {1}/{2}、{3} 分以内)。' -f $backoff, $failureTimes.Count, $MaxRestarts, $CrashWindowMinutes)
        Start-Sleep -Seconds $backoff
    }
}
catch {
    Write-HostLog -Level FATAL -Message ("監督プロセスで未処理のエラー: {0}`n{1}" -f $_.Exception.Message, $_.ScriptStackTrace)
    $exitCode = 5
}
finally {
    Set-SleepInhibition -Enable $false
    if ($mutexOwned -and (Test-Path -LiteralPath $pidPath)) {
        Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue
    }
    if ($mutexOwned -and $null -ne $mutex) { try { $mutex.ReleaseMutex() } catch { } }
    if ($null -ne $mutex) { $mutex.Dispose() }
    if (-not $script:QuietExit) {
        Write-HostLog -Level STOP -Message ('=== BELLO Dev Orchestrator 監督プロセス 終了 (exit {0}) ===' -f $exitCode)
    }
}

exit $exitCode

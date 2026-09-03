<#
.SYNOPSIS
    BELLO Dev Orchestrator の運用コマンド入口 (指示書 §15)。

.DESCRIPTION
    install / start / stop / restart / status / diagnose / repair / uninstall

    Windows PowerShell 5.1 で動く。管理者権限は不要。
    秘密値は表示しない。終了コードを正しく返す。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File bello.ps1 install
    powershell -ExecutionPolicy Bypass -File bello.ps1 status
#>
[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet('install', 'start', 'stop', 'restart', 'status', 'diagnose', 'repair', 'resume', 'uninstall', 'help')]
    [string] $Command = 'help',

    [string] $ConfigPath,
    [string] $TaskName = 'BelloDevOrchestrator',
    [string] $TaskPath = '\BELLO\',
    [int]    $StartDelaySeconds = 45,
    [ValidateRange(1, 60)]
    [int]    $WatchdogIntervalMinutes = 1,
    [switch] $Hidden,
    [switch] $ReportOnly
)

$ErrorActionPreference = 'Stop'

$BelloScriptDir = ''
if (-not [string]::IsNullOrWhiteSpace($PSScriptRoot)) { $BelloScriptDir = $PSScriptRoot }
if ([string]::IsNullOrWhiteSpace($BelloScriptDir) -and -not [string]::IsNullOrWhiteSpace($PSCommandPath)) {
    $BelloScriptDir = Split-Path -Parent $PSCommandPath
}
if ([string]::IsNullOrWhiteSpace($BelloScriptDir)) { $BelloScriptDir = (Get-Location).ProviderPath }

if ([string]::IsNullOrWhiteSpace($ConfigPath)) {
    $ConfigPath = Join-Path $BelloScriptDir 'bello-orchestrator.config.json'
}
$supervisor = Join-Path $BelloScriptDir 'Start-BelloOrchestrator.ps1'
$cli        = Join-Path $BelloScriptDir 'src\cli.mjs'

function Write-Ok    { param([string]$m) Write-Host ('  [ok]    ' + $m) -ForegroundColor Green }
function Write-Info  { param([string]$m) Write-Host ('  [info]  ' + $m) }
function Write-Warn2 { param([string]$m) Write-Host ('  [warn]  ' + $m) -ForegroundColor Yellow }
function Write-Fail  { param([string]$m) Write-Host ('  [NG]    ' + $m) -ForegroundColor Red }
function Write-Step  { param([string]$m) Write-Host ("`n=== $m ===") -ForegroundColor Cyan }
function Write-Action{ param([string]$m) Write-Host ('  [操作]  ' + $m) -ForegroundColor Magenta }

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

function Invoke-Cli {
    param([string[]] $CliArgs)
    $node = Resolve-NodeExe
    if (-not $node) {
        Write-Fail 'node.exe が見つかりません。Node.js 22.5 以降をインストールしてください。'
        return 3
    }
    # Out-Host を通さないと、子プロセスの出力が関数の戻り値に混ざり、
    # exit (Invoke-Cli ...) が壊れるうえ画面に何も出なくなる。
    & $node $cli @CliArgs | Out-Host
    return $LASTEXITCODE
}

function Get-BelloTask {
    return Get-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName -ErrorAction SilentlyContinue
}

# ---------------------------------------------------------------- install
function Invoke-Install {
    Write-Step '1. 前提の確認'

    $node = Resolve-NodeExe
    if (-not $node) {
        Write-Fail 'node.exe が見つかりません。https://nodejs.org から Node.js 22.5 以降をインストールしてください。'
        return 3
    }
    $nodeVersion = (& $node --version)
    Write-Ok "Node.js $nodeVersion ($node)"

    $versionText = $nodeVersion -replace '^v', ''
    $parts = $versionText.Split('.')
    $major = [int]$parts[0]
    $minor = [int]$parts[1]
    if ($major -lt 22 -or ($major -eq 22 -and $minor -lt 5)) {
        Write-Fail "node:sqlite を使うため Node.js 22.5 以降が必要です (現在 $nodeVersion)。"
        return 3
    }

    if (-not (Test-Path -LiteralPath $ConfigPath)) {
        Write-Fail "設定ファイルがありません: $ConfigPath"
        return 2
    }
    Write-Ok "設定ファイル: $ConfigPath"

    if (-not (Test-Path -LiteralPath $supervisor)) {
        Write-Fail "監督スクリプトがありません: $supervisor"
        return 2
    }

    Write-Step '2. 設定検証とディレクトリ作成'
    $diagExit = Invoke-Cli @('diagnose')
    if ($diagExit -ne 0) {
        Write-Warn2 '診断に警告があります。上の出力を確認してください。処理は続行します。'
    }

    Write-Step '3. 既存の常駐設定の確認'
    $existing = Get-BelloTask
    if ($existing) {
        Write-Info "既存タスクを更新します: $TaskPath$TaskName"
    } else {
        Write-Info "新規にタスクを登録します: $TaskPath$TaskName"
    }
    # Remote Control のタスクは別物。壊さないことを明示的に確認する (§11-1)。
    $rc = Get-ScheduledTask -TaskPath '\BELLO\' -TaskName 'ClaudeCodeRemoteControl' -ErrorAction SilentlyContinue
    if ($rc) {
        Write-Ok '既存の \BELLO\ClaudeCodeRemoteControl は別タスクとして残します (変更しません)。'
    }

    if ($ReportOnly) {
        Write-Info '(ReportOnly) タスクは登録しません。'
        return 0
    }

    Write-Step '4. Scheduled Task の登録'
    $systemRoot = [string]$env:SystemRoot
    if ([string]::IsNullOrWhiteSpace($systemRoot)) { $systemRoot = 'C:\Windows' }
    $psExe = Join-Path $systemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'

    $windowStyle = if ($Hidden) { 'Hidden' } else { 'Minimized' }
    $argLine = '-NoProfile -ExecutionPolicy Bypass -WindowStyle {0} -File "{1}" -ConfigPath "{2}" -Watchdog' -f `
        $windowStyle, $supervisor, $ConfigPath

    Write-Info "実行内容: `"$psExe`" $argLine"

    $userId = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    $action = New-ScheduledTaskAction -Execute $psExe -Argument $argLine -WorkingDirectory $BelloScriptDir

    # トリガ 1: ログオン時 (ネットワーク待ちのため遅延)
    $logonTrigger = New-ScheduledTaskTrigger -AtLogOn -User $userId
    $logonTrigger.Delay = ('PT{0}S' -f $StartDelaySeconds)

    # トリガ 2: 復旧ウォッチドッグ。ログオンしたままプロセスが落ちた場合に、
    # 再ログオンを待たずに復帰させる。IgnoreNew + Mutex により二重起動しない。
    $watchdogTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(-1) `
        -RepetitionInterval (New-TimeSpan -Minutes $WatchdogIntervalMinutes)
    try {
        $watchdogTrigger.Repetition.Duration = ''
        $watchdogTrigger.Repetition.StopAtDurationEnd = $false
    } catch {
        Write-Warn2 '繰り返し期間を「無期限」に設定できませんでした。既定値を使います。'
    }

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

    try {
        Register-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath `
            -Action $action -Trigger @($logonTrigger, $watchdogTrigger) -Principal $principal -Settings $settings `
            -Description ('BELLO Dev Orchestrator をログオン時に起動し、落ちた場合は {0} 分以内に復帰させます。' -f $WatchdogIntervalMinutes) `
            -Force | Out-Null
        Write-Ok "登録しました: $TaskPath$TaskName"
        Write-Info ('トリガ1: このユーザーのログオン時 ({0} 秒遅延)' -f $StartDelaySeconds)
        Write-Info ('トリガ2: 復旧ウォッチドッグ {0} 分ごと (無期限)' -f $WatchdogIntervalMinutes)
        Write-Info '多重起動: IgnoreNew + 名前付き Mutex の二重防御。実行時間制限なし。'
    } catch {
        Write-Fail ("タスクを登録できません: {0}" -f $_.Exception.Message)
        Write-Action "管理者権限は不要です。ご自身のユーザーで開いた通常の PowerShell から実行してください。"
        Write-Action "手動で起動する場合: powershell -ExecutionPolicy Bypass -File `"$supervisor`""
        return 3
    }

    Write-Step '5. 起動'
    try {
        Start-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName
        Write-Ok 'タスクを開始しました。'
    } catch {
        Write-Warn2 ("タスクを今すぐ開始できませんでした: {0}. ウォッチドッグが {1} 分以内に起動します。" -f $_.Exception.Message, $WatchdogIntervalMinutes)
    }

    Write-Step '次に確認すること'
    Write-Info ("状態確認: powershell -ExecutionPolicy Bypass -File `"{0}`" status" -f (Join-Path $BelloScriptDir 'bello.ps1'))
    Write-Info '成功の判定: status で「プロセス: 稼働中」と表示され、ダッシュボードが開けること。'
    return 0
}

# -------------------------------------------------------------- uninstall
function Invoke-Uninstall {
    Write-Step '常駐登録の解除'
    $task = Get-BelloTask
    if (-not $task) {
        Write-Info "タスクは登録されていません: $TaskPath$TaskName"
    } else {
        try {
            Stop-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName -ErrorAction SilentlyContinue
            Unregister-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName -Confirm:$false
            Write-Ok "解除しました: $TaskPath$TaskName"
        } catch {
            Write-Fail ("解除できません: {0}" -f $_.Exception.Message)
            return 3
        }
    }
    Write-Info 'プログラム本体と実行時データ (DB / ログ / 取込済み文書) は削除していません。'
    Write-Info '実行時データも消す場合は、設定の dataRoot フォルダを手動で削除してください。'
    Write-Ok '既存の \BELLO\ClaudeCodeRemoteControl には触れていません。'
    return 0
}

# ------------------------------------------------------------------ 実行
switch ($Command) {
    'install'   { exit (Invoke-Install) }
    'uninstall' { exit (Invoke-Uninstall) }
    'start' {
        # 手動 start は起動の意思表示なので、停止フラグと crash-loop
        # クールダウンを先に解除する。これが無いとウォッチドッグが
        # フラグを見て待機し、start しても何も起きない。
        [void](Invoke-Cli @('resume'))
        $task = Get-BelloTask
        if ($task) {
            [void](Invoke-Cli @('repair'))
            try {
                Start-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName
                Write-Ok 'Scheduled Task 経由で起動しました。'
                exit 0
            } catch {
                Write-Warn2 ("タスクを開始できません: {0}. 監督スクリプトを直接起動します。" -f $_.Exception.Message)
            }
        }
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $supervisor -ConfigPath $ConfigPath
        exit $LASTEXITCODE
    }
    'stop'    { exit (Invoke-Cli @('stop')) }
    'restart' {
        [void](Invoke-Cli @('stop'))
        Start-Sleep -Seconds 3
        [void](Invoke-Cli @('resume'))
        $task = Get-BelloTask
        if ($task) {
            [void](Invoke-Cli @('repair'))
            try { Start-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName; Write-Ok '再起動しました。'; exit 0 } catch { }
        }
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $supervisor -ConfigPath $ConfigPath
        exit $LASTEXITCODE
    }
    'status'   { exit (Invoke-Cli @('status')) }
    'diagnose' { exit (Invoke-Cli @('diagnose')) }
    'repair'   { exit (Invoke-Cli @('repair')) }
    'resume'   { exit (Invoke-Cli @('resume')) }
    default {
        Write-Host 'BELLO Dev Orchestrator'
        Write-Host ''
        Write-Host '  bello.ps1 install    依存確認・設定検証・ディレクトリ作成・常駐登録・起動'
        Write-Host '  bello.ps1 start      起動'
        Write-Host '  bello.ps1 stop       安全停止 (実行中の Claude タスクの終了を待ちます)'
        Write-Host '  bello.ps1 restart    再起動'
        Write-Host '  bello.ps1 status     稼働状態・キュー・未完了 TODO'
        Write-Host '  bello.ps1 diagnose   自己診断 (Claude / OpenAI 設定 / DB / 権限 / タスク / ディスク)'
        Write-Host '  bello.ps1 repair     安全に直せる設定のみ修復'
        Write-Host '  bello.ps1 resume     停止フラグ / crash-loop クールダウンを解除する'
        Write-Host '  bello.ps1 uninstall  常駐登録の解除 (本体とデータは消しません)'
        Write-Host ''
        Write-Host '  詳細は README.md と docs/ を参照してください。'
        exit 0
    }
}

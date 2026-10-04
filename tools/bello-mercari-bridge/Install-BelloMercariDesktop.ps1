param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[a-f0-9]{64}$')]
  [string]$RequestId,
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^https://[^/]+$')]
  [string]$BelloOrigin
)

$ErrorActionPreference = 'Stop'
$sourceDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$dataDir = Join-Path $env:LOCALAPPDATA 'BELLO\MercariBridge'
$appDir = Join-Path $dataDir 'App'
$configPath = Join-Path $dataDir 'config.json'
$desktop = [Environment]::GetFolderPath('Desktop')
$shortcutPath = Join-Path $desktop 'BELLO メルカリ照合.lnk'
$expectedOrigin = 'https://claude-inventory-management-system-5vbvc7.d4hkkg7dty2du.amplifyapp.com'
$nodeCommand = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1

if (-not $env:LOCALAPPDATA -or -not [IO.Path]::IsPathRooted($dataDir) -or
    -not $nodeCommand -or -not [IO.Path]::IsPathRooted($nodeCommand.Source) -or
    -not (Test-Path -LiteralPath $nodeCommand.Source)) {
  throw 'Node.js 24 と Windows のローカルアプリ領域が必要です。'
}
if ($BelloOrigin -ne $expectedOrigin) { throw '検証環境のBELLO URLだけを設定できます。' }
$nodePath = $nodeCommand.Source
$version = & $nodePath --version
if ($LASTEXITCODE -ne 0 -or [int]($version -replace '^v(\d+)\..*$', '$1') -lt 24) {
  throw 'Node.js 24 以降が必要です。'
}
if (Test-Path -LiteralPath $configPath) {
  $existing = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
  if ($existing.origin -ne $BelloOrigin -or $existing.requestId -ne $RequestId) {
    throw 'このPCには別のBELLO読取依頼が設定済みです。既存設定を確認してください。'
  }
}

$nodeProcesses = Get-CimInstance Win32_Process -Filter "Name = 'node.exe' OR Name = 'nodew.exe'"
foreach ($nodeProcess in $nodeProcesses) {
  if ([string]::IsNullOrWhiteSpace($nodeProcess.CommandLine)) {
    throw '稼働中のNode.jsを確認できません。PCアプリを停止した後に再実行してください。'
  }
  if ($nodeProcess.CommandLine -match 'desktopApp\.mjs') {
    throw 'BELLOのPCアプリが稼働中です。現在の作業を終えてアプリを終了した後に更新してください。'
  }
}

New-Item -ItemType Directory -Path $dataDir, $appDir -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $appDir 'src') -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $sourceDir 'package.json') -Destination $appDir -Force
Copy-Item -LiteralPath (Join-Path $sourceDir 'package-lock.json') -Destination $appDir -Force
$cmdText = Get-Content -LiteralPath (Join-Path $sourceDir 'BELLOメルカリ照合.cmd') -Raw
$cmdText = $cmdText -replace "`r?`n", "`r`n"
[IO.File]::WriteAllText((Join-Path $appDir 'BELLOメルカリ照合.cmd'), $cmdText, [Text.Encoding]::ASCII)
Get-ChildItem -LiteralPath (Join-Path $sourceDir 'src') -File | ForEach-Object {
  Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $appDir 'src') -Force
}
& npm ci --ignore-scripts --no-audit --no-fund --prefix $appDir
if ($LASTEXITCODE -ne 0) { throw 'PCアプリの準備に失敗しました。' }

if (-not $existing) {
  $existing = [pscustomobject]@{ origin = $BelloOrigin; requestId = $RequestId; dataDir = $dataDir }
}
$existing | Add-Member -NotePropertyName controlPort -NotePropertyValue 56210 -Force
$configTemporaryPath = "$configPath.tmp"
[IO.File]::WriteAllText($configTemporaryPath, ($existing | ConvertTo-Json -Compress -Depth 30), [Text.UTF8Encoding]::new($false))
Move-Item -LiteralPath $configTemporaryPath -Destination $configPath -Force

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $nodePath
$shortcut.Arguments = ('"{0}" --config "{1}"' -f (Join-Path $appDir 'src\desktopApp.mjs'), $configPath)
$shortcut.WorkingDirectory = $appDir
$shortcut.WindowStyle = 1
$shortcut.Description = 'BELLOの既存メルカリShops商品を照合し、限定の非公開保存を行います'
$shortcut.Save()

$protocolPath = 'HKCU:\Software\Classes\bello-mercari-bridge'
$commandPath = Join-Path $protocolPath 'shell\open\command'
New-Item -Path $protocolPath -Force | Out-Null
New-Item -Path (Join-Path $protocolPath 'shell') -Force | Out-Null
New-Item -Path (Join-Path $protocolPath 'shell\open') -Force | Out-Null
New-Item -Path $commandPath -Force | Out-Null
Set-Item -Path $protocolPath -Value 'URL:BELLO メルカリ照合'
New-ItemProperty -Path $protocolPath -Name 'URL Protocol' -Value '' -PropertyType String -Force | Out-Null
$launcherPath = Join-Path $appDir 'src\desktopLauncher.mjs'
$protocolCommand = ('"{0}" "{1}" "%1"' -f $nodePath, $launcherPath)
Set-Item -Path $commandPath -Value $protocolCommand

Write-Output "READY: $shortcutPath"

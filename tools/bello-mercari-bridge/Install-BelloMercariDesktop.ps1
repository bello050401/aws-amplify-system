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

if (-not $env:LOCALAPPDATA -or -not [IO.Path]::IsPathRooted($dataDir) -or
    -not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw 'Node.js 24 と Windows のローカルアプリ領域が必要です。'
}
if ($BelloOrigin -ne $expectedOrigin) { throw '検証環境のBELLO URLだけを設定できます。' }
$version = & node --version
if ($LASTEXITCODE -ne 0 -or [int]($version -replace '^v(\d+)\..*$', '$1') -lt 24) {
  throw 'Node.js 24 以降が必要です。'
}
if (Test-Path -LiteralPath $configPath) {
  $existing = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
  if ($existing.origin -ne $BelloOrigin -or $existing.requestId -ne $RequestId) {
    throw 'このPCには別のBELLO読取依頼が設定済みです。既存設定を確認してください。'
  }
}

New-Item -ItemType Directory -Path $dataDir, $appDir -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $appDir 'src') -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $sourceDir 'package.json') -Destination $appDir -Force
Copy-Item -LiteralPath (Join-Path $sourceDir 'package-lock.json') -Destination $appDir -Force
Copy-Item -LiteralPath (Join-Path $sourceDir 'BELLOメルカリ照合.cmd') -Destination $appDir -Force
Get-ChildItem -LiteralPath (Join-Path $sourceDir 'src') -File | ForEach-Object {
  Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $appDir 'src') -Force
}
if (-not (Test-Path -LiteralPath $configPath)) {
  $configuration = @{ origin = $BelloOrigin; requestId = $RequestId; dataDir = $dataDir } | ConvertTo-Json -Compress
  [IO.File]::WriteAllText($configPath, $configuration, [Text.UTF8Encoding]::new($false))
}

& npm ci --ignore-scripts --no-audit --no-fund --prefix $appDir
if ($LASTEXITCODE -ne 0) { throw 'PCアプリの準備に失敗しました。' }

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = Join-Path $appDir 'BELLOメルカリ照合.cmd'
$shortcut.WorkingDirectory = $appDir
$shortcut.WindowStyle = 7
$shortcut.Description = 'BELLOの既存メルカリShops商品を読み取り専用で照合します'
$shortcut.Save()

Write-Output "READY: $shortcutPath"

param(
    [Parameter(Mandatory)][string]$NodeExe,
    [Parameter(Mandatory)][string]$NsisExe,
    [Parameter(Mandatory)][string]$OutputDir,
    [string]$NodeLicense,
    [string]$Version = '1.0.0'
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw 'Version must be major.minor.patch.' }
$stationRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$output = [IO.Path]::GetFullPath($OutputDir).TrimEnd('\')
$NodeExe = (Resolve-Path -LiteralPath $NodeExe).Path
$NsisExe = (Resolve-Path -LiteralPath $NsisExe).Path
# Never empty or recursively delete a caller-selected directory. A fresh directory
# also prevents credentials or old application data leaking into a later build.
if ($output -eq [IO.Path]::GetPathRoot($output).TrimEnd('\') -or
    $stationRoot.StartsWith($output + '\', [StringComparison]::OrdinalIgnoreCase) -or
    $output -eq $stationRoot -or $output.StartsWith($stationRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'OutputDir must be a separate, empty build directory outside the source tree.'
}
$ancestor = $output
while ($ancestor) {
    if (Test-Path -LiteralPath $ancestor) {
        if ((Get-Item -LiteralPath $ancestor).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Output path cannot traverse a link or junction.' }
    }
    $ancestor = Split-Path -Parent $ancestor
}
if (Test-Path -LiteralPath $output) {
    if (!(Test-Path -LiteralPath $output -PathType Container) -or @(Get-ChildItem -LiteralPath $output -Force).Count) { throw 'OutputDir must be empty.' }
}
$nodeInfo = & $NodeExe -p 'JSON.stringify({platform:process.platform,arch:process.arch,version:process.version})' | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or $nodeInfo.platform -ne 'win32' -or $nodeInfo.arch -ne 'x64') { throw 'A Windows x64 Node executable is required.' }
$npmCmd = Join-Path (Split-Path -Parent $NodeExe) 'npm.cmd'
if (!(Test-Path -LiteralPath $npmCmd)) { throw 'npm.cmd must be alongside the supplied build-time Node executable.' }
New-Item -ItemType Directory -Path $output -Force | Out-Null
$payload = Join-Path $output 'payload'
$pipeline = Join-Path $payload 'pipeline'
New-Item -ItemType Directory -Path $pipeline -Force | Out-Null
$project = Join-Path $stationRoot 'windows/src/PhotoStation.Desktop/PhotoStation.Desktop.csproj'
& dotnet publish $project --configuration Release --runtime win-x64 --self-contained true '-p:PublishSingleFile=true' '-p:IncludeNativeLibrariesForSelfExtract=true' '-p:DebugType=None' '-p:DebugSymbols=false' --output $payload --nologo
if ($LASTEXITCODE -ne 0) { throw 'Desktop publish failed.' }
Copy-Item -LiteralPath $NodeExe -Destination (Join-Path $payload 'node.exe')
# Only repository-owned pipeline sources and explicitly selected assets are copied.
New-Item -ItemType Directory -Path (Join-Path $pipeline 'src') -Force | Out-Null
Get-ChildItem -LiteralPath (Join-Path $stationRoot 'src') -Filter '*.mjs' -File | Copy-Item -Destination (Join-Path $pipeline 'src')
foreach ($file in @('package.json', 'package-lock.json')) { Copy-Item -LiteralPath (Join-Path $stationRoot $file) -Destination $pipeline }
New-Item -ItemType Directory -Path (Join-Path $pipeline 'assets'),(Join-Path $pipeline 'presets') -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $stationRoot 'assets/BelloStamp.png') -Destination (Join-Path $pipeline 'assets')
Get-ChildItem -LiteralPath (Join-Path $stationRoot 'presets') -Filter '*.xmp' -File | Copy-Item -Destination (Join-Path $pipeline 'presets')
$plugin = Join-Path $payload 'lightroom/BelloPhotoStation.lrplugin'
New-Item -ItemType Directory -Path $plugin -Force | Out-Null
foreach ($file in @('Info.lua','Connect.lua','Start.lua','Stop.lua')) { Copy-Item -LiteralPath (Join-Path $stationRoot ('lightroom/BelloPhotoStation.lrplugin/' + $file)) -Destination $plugin }
Copy-Item -LiteralPath (Join-Path $stationRoot 'Install-LightroomBridge.ps1') -Destination $payload
Copy-Item -LiteralPath (Join-Path $stationRoot 'windows/src/PhotoStation.Desktop/Assets/BelloPhotoStation.ico') -Destination (Join-Path $payload 'BelloPhotoStation.ico')
if (!$NodeLicense) { $NodeLicense = Join-Path (Split-Path -Parent $NodeExe) 'LICENSE' }
if (!(Test-Path -LiteralPath $NodeLicense -PathType Leaf)) { throw 'Node runtime LICENSE is required; supply -NodeLicense from the same Node release.' }
Copy-Item -LiteralPath $NodeLicense -Destination (Join-Path $payload 'Node-LICENSE.txt')
$dotnetDir = Split-Path -Parent (Get-Command dotnet.exe).Source
foreach ($license in @('LICENSE.txt','ThirdPartyNotices.txt')) {
    $sourceLicense = Join-Path $dotnetDir $license
    if (!(Test-Path -LiteralPath $sourceLicense)) { throw "Missing .NET license: $license" }
    Copy-Item -LiteralPath $sourceLicense -Destination (Join-Path $payload ('.NET-' + $license))
}
Push-Location $pipeline
try {
    & $npmCmd ci --omit=dev --ignore-scripts --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'Production dependency installation failed.' }
} finally { Pop-Location }
$guide = @'
BELLO Photo Station — 1.0

Windows 10/11・64ビット用です。.NETとNode.jsは同梱されています。
スタートメニューの「BELLO Photo Station」から起動してください。

1. 最初に「保存先」を選んでください。
   ・BELLO WEB 自社システム：既存の写真用アカウントでログインします。
     初期表示のユーザー名は photo-device-e2e です。割り当てられた別アカウントにも変更できます。
     既存の画像登録API・画像登録先・商品への紐付け手順はそのままです。
   ・使用中のPC：フォルダーを選んで保存します。WEBログインは不要です。
   ・社内共有フォルダー：フォルダーを選ぶか、\\サーバー\共有\写真 のように入力します。
     Windowsでアクセスでき、書き込み権限のある場所を選んでください。

2. SDカードから商品ごとの写真を取り込み、仕上がりを比較して保存します。
   PC・共有先には、商品ごとのBELLO-から始まるフォルダーを作り、
   編集済みJPEG・サムネイル・保存内容の一覧を格納します。
   同じ設定の再実行は内容を照合し、保存済み写真を重複作成しません。
   編集した保存済みファイルは上書きしません。別フォルダーを選んで再実行してください。
   保存に失敗した場合、取込履歴を選んで再実行できます。
   PC・共有先へ保存した写真は、履歴を選んで後からBELLO WEBにも保存できます。

別PCでも同じインストーラーを実行してください。
AWSの開発用認証設定やNode.jsのインストールは不要です。
社外からBELLO WEBへ保存する場合は、インターネット接続が必要です。
社外から社内共有フォルダーへ保存する場合は、会社のVPNなどで共有先に接続してください。
PC・共有先への保存だけならWEBにログインする必要はありません。
パスワードは保存せず、継続ログインの情報をWindowsユーザーごとに暗号化して保存します。
「WEBからログアウト」でこのPCのログイン情報を削除できます。

写真・設定・取込履歴は通常、次の場所へ保存されます。
%LOCALAPPDATA%\BELLO\PhotoStation\staging
既存のBELLO_PHOTO_STATION_ROOT設定がある場合は、その設定を使用します。
アンインストールしても、この写真・設定・履歴は削除しません。
アプリのインストール先フォルダーへ写真を保存しないでください。

従来のプリセット現像には、各PCにLightroom Classicと利用できるライセンスが必要です。
Lightroom Classic本体は同梱していません。
画面の「Lightroom連携の設定」で連携ファイルを配置し、Lightroomを再起動して、
ファイル → プラグインマネージャーでBELLO Photo Stationを有効にしてください。
その後、ファイル → プラグインエクストラ → BELLO連携を開始 を選びます。
Lightroomの導入・ライセンス認証が済んでいれば、PC保存はオフラインでも処理できます。
アンインストール時、既存Lightroomのプラグインやプリセットは削除しません。

インストーラーには個人の写真・パスワード・AWS認証情報を含めていません。
WEB保存後の再編集用原本は従来どおり7日間保持します。
フォルダー保存だけの原本は、自動削除の対象にしません。

削除: Windowsの「設定 → アプリ」からBELLO Photo Stationを選択します。
この版にはコード署名証明書による電子署名は付いていません。
'@
[IO.File]::WriteAllText((Join-Path $payload 'お読みください.txt'), $guide, [Text.UTF8Encoding]::new($true))
[IO.File]::WriteAllText((Join-Path $payload '.bello-photo-install'), 'BELLO-PHOTO-STATION-INSTALL-v1', [Text.UTF8Encoding]::new($false))
$manifest = @(Get-ChildItem -LiteralPath $payload -Recurse -File -Force | ForEach-Object {
    [ordered]@{ path = [IO.Path]::GetRelativePath($payload, $_.FullName).Replace('\','/'); bytes = $_.Length; sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant() }
})
$manifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $payload 'package-manifest.json') -Encoding utf8
& (Join-Path $PSScriptRoot 'Verify-Package.ps1') -PayloadDir $payload
if (!$?) { throw 'Package verification failed.' }
# Delete only build-manifest files on uninstall; never use RMDir /r, so unknown
# user files and all application data outside the installation are preserved.
$uninstallLines = [Collections.Generic.List[string]]::new()
foreach ($file in Get-ChildItem -LiteralPath $payload -Recurse -File -Force) {
    $relative = [IO.Path]::GetRelativePath($payload,$file.FullName).Replace('$','$$')
    $uninstallLines.Add('Delete "$INSTDIR\' + $relative + '"')
}
$uninstallLines.Add('Delete "$INSTDIR\Uninstall.exe"')
foreach ($directory in Get-ChildItem -LiteralPath $payload -Recurse -Directory | Sort-Object { $_.FullName.Length } -Descending) {
    $relative = [IO.Path]::GetRelativePath($payload,$directory.FullName).Replace('$','$$')
    $uninstallLines.Add('RMDir "$INSTDIR\' + $relative + '"')
}
$uninstallLines.Add('RMDir "$INSTDIR"')
$uninstallInclude = Join-Path $output 'uninstall-files.nsh'
[IO.File]::WriteAllLines($uninstallInclude,$uninstallLines,[Text.UTF8Encoding]::new($true))
$installer = Join-Path $output "BELLO-Photo-Station-Setup-$Version-x64.exe"
& $NsisExe '/V2' '/INPUTCHARSET' 'UTF8' "/DPAYLOAD_DIR=$payload" "/DOUTPUT_FILE=$installer" "/DUNINSTALL_INCLUDE=$uninstallInclude" "/DAPP_VERSION=$Version" (Join-Path $PSScriptRoot 'PhotoStation.nsi')
if ($LASTEXITCODE -ne 0 -or !(Test-Path -LiteralPath $installer)) { throw 'NSIS installer compilation failed.' }
$receipt = [ordered]@{ version=$Version; installer=$installer; sha256=(Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant(); bytes=(Get-Item -LiteralPath $installer).Length; payloadFiles=$manifest.Count; nodeVersion=$nodeInfo.version; signed=$false }
$receipt | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $output 'build-receipt.json') -Encoding utf8
$receipt | ConvertTo-Json

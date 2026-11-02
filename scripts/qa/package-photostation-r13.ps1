param(
  [Parameter(Mandatory)][string]$OutputDirectory,
  [Parameter(Mandatory)][string]$PublishedApp
)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$source=Join-Path $repo 'tools/bello-photo-station'
$output=(Resolve-Path -LiteralPath $OutputDirectory).Path
$package=(Resolve-Path -LiteralPath (Join-Path $output 'BELLO-Photo-Station-Windows-x64')).Path
$app=Join-Path $package 'app'
$pipeline=Join-Path $app 'pipeline'
if (!(Test-Path -LiteralPath (Join-Path $PublishedApp 'PhotoStation.Desktop.exe'))) {throw 'Published executable missing'}
Get-ChildItem -LiteralPath $PublishedApp -Force | Copy-Item -Destination $app -Recurse -Force
Get-ChildItem -LiteralPath (Join-Path $source 'src') -Filter '*.mjs' -File | Copy-Item -Destination (Join-Path $pipeline 'src') -Force
foreach($name in @('package.json','package-lock.json')) {Copy-Item -LiteralPath (Join-Path $source $name) -Destination $pipeline -Force}
foreach($name in @('Info.lua','Connect.lua','Start.lua','Stop.lua')) {Copy-Item -LiteralPath (Join-Path $source ('lightroom/BelloPhotoStation.lrplugin/'+$name)) -Destination (Join-Path $app 'lightroom/BelloPhotoStation.lrplugin') -Force}
foreach($name in @('Install-LightroomBridge.ps1','Configure-DedicatedPC.ps1','Test-PhotoStationReadiness.ps1')) {
  [IO.File]::WriteAllText((Join-Path $app $name),[IO.File]::ReadAllText((Join-Path $source $name)),[Text.UTF8Encoding]::new($true))
}
Push-Location $pipeline
try { & npm.cmd ci --omit=dev --ignore-scripts --no-audit --no-fund; if($LASTEXITCODE -ne 0){throw 'Dependency installation failed'} }
finally {Pop-Location}
$guide=@'
BELLO Photo Station r13 / 4:3 / タッチ対応フル版
2026年11月2日

変更内容
横長の比率を3:2から4:3へ変更しました。正方形1:1も選べます。
位置調整画面と保存写真・サムネイルが同じ比率になります。
中央からの位置調整、指で移動・拡大、原本アップロードは維持しています。
旧版の3:2で途中保存した写真は、4:3の枠で全写真を再確認してください。
すでに保存・アップロードした写真を、この更新だけで作り直すことはありません。

新しいPCで使う
1. ZIPを「すべて展開」してください。
2. BELLO-Photo-Station-Windows-x64フォルダーを丸ごと置いてください。
3. 「写真取込専用で起動.cmd」を開きます（タッチ版）。
4. 保存先・ログイン・設定で保存先を選びます。
Lightroom Classic本体と有効なAdobe認証は別途必要です。

設定・ログイン・履歴を残して更新する
1. 写真の処理が終わってからPhotoStationとLightroom Classicを閉じます。
2. ZIPを別の場所へ展開します。
3. 新しいフォルダーの「app」フォルダーを、今使っているフォルダーへコピーして上書きします。
4. 今使っている「data」フォルダーは削除・上書きしないでください。
5. いつもの「写真取込専用で起動.cmd」から起動してください。
位置調整画面に「横長 4:3」と表示されれば更新済みです。
コピーした新しいフォルダーのdataへ、ログイン情報や写真を移す必要はありません。

編集前の原本
保存先が「BELLO WEB 自社システム」の場合、取込直後に元ファイルを再圧縮せずアップロードします。
Webの画像登録→編集前の取込写真で確認できます。
クラウドの原本保管期限は商品と紐付け後7日間です。加工後の画像はこの期限では削除しません。

この配布ファイルには個人のログイン情報・撮影写真・取込履歴は含めていません。
SDカードの原本を削除・変更する更新ではありません。
画像処理142項目、Windows側71項目のテストに合格しています。
実タブレットの物理タッチおよび実Lightroomでの再現像は今回の比率変更テストには含めていません。
'@
[IO.File]::WriteAllText((Join-Path $package 'はじめにお読みください.txt'),$guide,[Text.UTF8Encoding]::new($true))
[IO.File]::WriteAllText((Join-Path $output '更新手順.txt'),$guide,[Text.UTF8Encoding]::new($true))
$oldManifest=Join-Path $package 'version-r12.json'
if(Test-Path -LiteralPath $oldManifest){Remove-Item -LiteralPath $oldManifest}
$dataNames=@(Get-ChildItem -LiteralPath (Join-Path $package 'data') -Force | Select-Object -ExpandProperty Name)
if(@($dataNames | Where-Object {$_ -notin @('default-preset.json','presets')}).Count){throw 'Unexpected data in release'}
$entries=@(foreach($file in Get-ChildItem -LiteralPath $package -File -Recurse -Force) {
  $relative=[IO.Path]::GetRelativePath($package,$file.FullName).Replace('\','/')
  if($relative -match '(^|/)(\.aws|\.git|\.env[^/]*|credentials|history\.json|station\.sqlite[^/]*|validation-refresh\.dpapi|sessions)(/|$)' -or $relative -match '\.(arw|cr2|nef|jpe?g|har|pem|pfx|dpapi|sqlite|db)$'){throw "Unexpected personal data: $relative"}
  if($relative -ne 'version-r13.json'){@{path=$relative;size=$file.Length;sha256=(Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()}}
})
$manifest=@{version='r13-4x3';builtAt=[DateTimeOffset]::UtcNow.ToString('o');touchEnabled=$true;personalDataIncluded=$false;aspectRatios=@('1:1','4:3');files=$entries}
[IO.File]::WriteAllText((Join-Path $package 'version-r13.json'),($manifest|ConvertTo-Json -Depth 5),[Text.UTF8Encoding]::new($false))
$archive=Join-Path $output 'BELLO-Photo-Station-r13-タッチ対応フル版-4対3.zip'
Compress-Archive -LiteralPath $package -DestinationPath $archive -CompressionLevel Optimal -Force
$hash=(Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash
[IO.File]::WriteAllText((Join-Path $output 'SHA256.txt'),$hash+'  '+[IO.Path]::GetFileName($archive),[Text.UTF8Encoding]::new($false))
Write-Output "Packaged $($entries.Count) files. ZIP: $archive"

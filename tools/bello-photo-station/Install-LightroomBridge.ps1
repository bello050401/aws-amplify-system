param([string]$StationRoot, [switch]$PreserveExistingRoot)
$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($StationRoot)) {
    $StationRoot = $env:BELLO_PHOTO_STATION_ROOT
    if ([string]::IsNullOrWhiteSpace($StationRoot)) { $StationRoot = Join-Path $env:LOCALAPPDATA 'BELLO/PhotoStation/staging' }
}
$source = Join-Path $PSScriptRoot 'lightroom/BelloPhotoStation.lrplugin'
$destination = Join-Path $env:APPDATA 'Adobe/Lightroom/Modules/BelloPhotoStation.lrplugin'
$config = Join-Path $destination 'root.txt'
$requestedRoot = [IO.Path]::GetFullPath($StationRoot)
if ($PreserveExistingRoot -and (Test-Path -LiteralPath $config)) {
    $existingRoot = [IO.File]::ReadAllText($config, [Text.Encoding]::UTF8).Trim()
    if ([IO.Path]::IsPathRooted($existingRoot) -and (Test-Path -LiteralPath $existingRoot -PathType Container)) { $StationRoot = $existingRoot }
}
foreach ($name in @('Info.lua', 'Start.lua', 'Stop.lua', 'Connect.lua')) {
    if (!(Test-Path -LiteralPath (Join-Path $source $name))) { throw 'Lightroom連携ファイルがありません。フォルダー全体を展開してください。' }
}
$changed = $false
New-Item -ItemType Directory -Path $destination -Force | Out-Null
foreach ($name in @('Info.lua', 'Start.lua', 'Stop.lua', 'Connect.lua')) {
    $from = Join-Path $source $name
    $to = Join-Path $destination $name
    if (!(Test-Path -LiteralPath $to) -or (Get-FileHash -LiteralPath $from).Hash -ne (Get-FileHash -LiteralPath $to).Hash) {
        Copy-Item -LiteralPath $from -Destination $to -Force
        $changed = $true
    }
}
$StationRoot = [IO.Path]::GetFullPath($StationRoot)
New-Item -ItemType Directory -Path $StationRoot -Force | Out-Null
if (!(Test-Path -LiteralPath $config) -or [IO.File]::ReadAllText($config, [Text.Encoding]::UTF8).Trim() -ne $StationRoot) {
    [IO.File]::WriteAllText($config, $StationRoot, [Text.UTF8Encoding]::new($false))
    $changed = $true
}
$presetDir = Join-Path $env:APPDATA 'Adobe/CameraRaw/Settings'
New-Item -ItemType Directory -Path $presetDir -Force | Out-Null
$presetRoots = @((Join-Path $requestedRoot 'presets'), (Join-Path $PSScriptRoot 'presets'), (Join-Path $PSScriptRoot 'pipeline/presets'))
$seen = @{}
foreach ($presetRoot in $presetRoots) {
    if (!(Test-Path -LiteralPath $presetRoot)) { continue }
    foreach ($preset in Get-ChildItem -LiteralPath $presetRoot -Filter '*.xmp' -File) {
        $text = [IO.File]::ReadAllText($preset.FullName, [Text.Encoding]::UTF8)
        $uuid = [regex]::Match($text, 'crs:UUID="([^"]+)"').Groups[1].Value
        $key = if ($uuid) { $uuid.Replace('-', '').ToUpperInvariant() } else { $preset.Name }
        if ($seen.ContainsKey($key)) { continue }
        $seen[$key] = $true
        $hash = (Get-FileHash -LiteralPath $preset.FullName -Algorithm SHA256).Hash
        $match = $null
        foreach ($installed in Get-ChildItem -LiteralPath $presetDir -Filter '*.xmp' -File -Recurse) {
            if ((Get-FileHash -LiteralPath $installed.FullName -Algorithm SHA256).Hash -eq $hash) { $match = $installed; break }
            $installedText = [IO.File]::ReadAllText($installed.FullName, [Text.Encoding]::UTF8)
            $installedUuid = [regex]::Match($installedText, 'crs:UUID="([^"]+)"').Groups[1].Value
            if ($uuid -and $installedUuid.Replace('-', '').ToUpperInvariant() -eq $key) { $match = $installed; break }
        }
        $presetTarget = Join-Path $presetDir $preset.Name
        if ($match -or (Test-Path -LiteralPath $presetTarget)) {
            if (!$match -or (Get-FileHash -LiteralPath $match.FullName -Algorithm SHA256).Hash -ne $hash) {
                Write-Output ('既存のプリセットを保持しました。内容を確認してください: ' + $preset.Name)
            }
            continue
        }
        Copy-Item -LiteralPath $preset.FullName -Destination $presetTarget
        $changed = $true
    }
}
if ($changed) { Write-Output 'BELLO_LIGHTROOM_RELOAD_REQUIRED' }
Write-Output 'Lightroom連携を配置しました。Lightroomを再起動し、ファイル→プラグインマネージャーでBELLO Photo Stationを確認してください。'
Write-Output $destination

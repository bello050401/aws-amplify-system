param(
    [ValidateSet('Enable', 'Disable')][string]$Mode = 'Enable',
    [string]$DesktopDirectory = [Environment]::GetFolderPath('DesktopDirectory'),
    [string]$StartupDirectory = [Environment]::GetFolderPath('Startup')
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$exe = Join-Path $PSScriptRoot 'PhotoStation.Desktop.exe'
$linkName = 'BELLO Photo Station 専用.lnk'
$startupLink = Join-Path $StartupDirectory $linkName
$desktopLink = Join-Path $DesktopDirectory $linkName
if ($Mode -eq 'Disable') {
    # Remove only the startup shortcut owned by this installation.
    if (Test-Path -LiteralPath $startupLink) {
        $shell = New-Object -ComObject WScript.Shell
        try {
            $link = $shell.CreateShortcut($startupLink)
            if ($link.TargetPath -ine [IO.Path]::GetFullPath($exe)) {
                throw 'This shortcut belongs to another BELLO installation. Run its setup to disable it.'
            }
            Remove-Item -LiteralPath $startupLink
        } finally { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell) }
    }
    Write-Output '自動起動を解除しました。デスクトップからの手動起動は引き続き使えます。'
    exit 0
}
if (!(Test-Path -LiteralPath $exe -PathType Leaf)) { throw 'Extract the entire ZIP before running this setup.' }
foreach ($directory in @($DesktopDirectory, $StartupDirectory)) {
    if (![IO.Path]::IsPathRooted($directory)) { throw 'Shortcut directories must use absolute paths.' }
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
}
$shell = New-Object -ComObject WScript.Shell
try {
    foreach ($path in @($startupLink, $desktopLink)) {
        $link = $shell.CreateShortcut($path)
        $link.TargetPath = [IO.Path]::GetFullPath($exe)
        $link.Arguments = '--test-mode --touch-mode'
        $link.WorkingDirectory = $PSScriptRoot
        $link.Description = 'BELLO 写真取込専用：タッチ画面とLightroom連携'
        $link.IconLocation = (Join-Path $PSScriptRoot 'BelloPhotoStation.ico') + ',0'
        $link.WindowStyle = 3
        $link.Save()
    }
} finally { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell) }
Write-Output '設定が完了しました。次回のWindowsログイン後にBELLOとLightroom Classicを起動します。'
Write-Output '今すぐ使う場合は、デスクトップの「BELLO Photo Station 専用」を開いてください。'
Write-Output 'このフォルダーを移動した場合は、移動先で「専用PCに設定.cmd」をもう一度実行してください。'

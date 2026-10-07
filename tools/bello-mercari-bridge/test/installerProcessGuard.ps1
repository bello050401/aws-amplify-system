$ErrorActionPreference = 'Stop'
. (Join-Path (Split-Path -Parent $PSScriptRoot) 'InstallerProcessGuard.ps1')
$dataDir = 'C:\Users\win\AppData\Local\BELLO\MercariBridge'
$cases = @(
  @{ Name='node.exe'; Line='node src/cli.mjs run-b005659-private-create-ui-once'; Expected=$true },
  @{ Name='node.exe'; Line='node C:\Users\win\AppData\Local\BELLO\MercariBridge\App\src\desktopApp.mjs'; Expected=$true },
  @{ Name='chrome.exe'; Line=('chrome.exe --user-data-dir="' + (Join-Path $dataDir 'ShopsChrome') + '" about:blank'); Expected=$true },
  @{ Name='msedge.exe'; Line=('msedge.exe --user-data-dir=' + (Join-Path $dataDir 'BELLOChrome')); Expected=$true },
  @{ Name='node.exe'; Line='node unrelated.js'; Expected=$false },
  @{ Name='chrome.exe'; Line=('chrome.exe --user-data-dir=' + (Join-Path $dataDir 'ShopsChromeBackup')); Expected=$false }
)
foreach ($case in $cases) {
  $actual = Test-BelloMercariInstallBlocker -Name $case.Name -CommandLine $case.Line -DataDir $dataDir
  if ($actual -ne $case.Expected) { throw "Incorrect install blocker for $($case.Name)" }
}
Write-Output 'INSTALLER_PROCESS_GUARD_OK'

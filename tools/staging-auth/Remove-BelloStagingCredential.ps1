<#
    Delete the stored Staging credential, and the saved Playwright login
    state along with it - a storageState file holds live Cognito tokens,
    so it is a credential too and must not outlive the password.

        powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\staging-auth\Remove-BelloStagingCredential.ps1
#>
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Import-Module (Join-Path $PSScriptRoot 'BelloCredential.psm1') -Force

if (Remove-BelloCredential) {
    Write-Host 'Removed from Windows Credential Manager.' -ForegroundColor Green
} else {
    Write-Host 'Nothing was stored.' -ForegroundColor Yellow
}

$stateDir = Join-Path $env:LOCALAPPDATA 'BELLO\playwright'
if (Test-Path $stateDir) {
    Remove-Item -Recurse -Force $stateDir
    Write-Host ('Removed saved login state: ' + $stateDir) -ForegroundColor Green
}

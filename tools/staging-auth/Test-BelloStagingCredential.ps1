<#
    Report whether a Staging credential is stored. Never prints the value.

        powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\staging-auth\Test-BelloStagingCredential.ps1
#>
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Import-Module (Join-Path $PSScriptRoot 'BelloCredential.psm1') -Force

$cred = Get-BelloCredential
if ($null -eq $cred) {
    Write-Host 'Not stored.' -ForegroundColor Yellow
    Write-Host '  powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\staging-auth\Set-BelloStagingCredential.ps1'
    exit 1
}
Write-Host 'Stored.' -ForegroundColor Green
Write-Host ('  Target  : ' + (Get-BelloCredentialTarget))
Write-Host ('  User    : ' + $cred.UserName)
Write-Host ('  Password: (' + $cred.Password.Length + ' characters; value not shown)')

<#
    Store the BELLO Staging sign-in in the Windows Credential Manager.

    THIS IS THE ONE COMMAND A PERSON RUNS, ONCE, ON THIS MACHINE:

        powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\staging-auth\Set-BelloStagingCredential.ps1

    HOW THE PASSWORD IS COLLECTED

    Get-Credential is used, not Read-Host -AsSecureString. The difference
    matters in practice: Read-Host -AsSecureString requires a real console,
    and inside an IDE terminal, an agent shell, or any host with redirected
    stdin it does not fail - it **blocks forever**. That is exactly the
    failure mode that makes someone believe they registered a credential
    when nothing was stored. Get-Credential falls back to a Windows dialog
    when no console is attached, so it works in both cases.

    Either way the password is a SecureString, is never echoed, and never
    becomes a command-line argument, so it cannot reach PSReadLine history.

    After writing, the credential is read straight back. CredWrite
    reporting success is not the same as the value being retrievable, and
    a silent half-success here would send the automation chasing a phantom.

    Stored in : Windows Credential Manager (generic credential)
    Target    : BELLO/staging/inventory
    Scope     : Staging only. Do not reuse this for Production.

    To remove it later:
        powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\staging-auth\Remove-BelloStagingCredential.ps1
#>
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Import-Module (Join-Path $PSScriptRoot 'BelloCredential.psm1') -Force

Write-Host ''
Write-Host 'Store the BELLO Staging sign-in in Windows Credential Manager.' -ForegroundColor Cyan
Write-Host '  Scope : Staging (bello-inventory-staging) only. Never Production.'
Write-Host ('  Target: ' + (Get-BelloCredentialTarget))
Write-Host ''
Write-Host 'A credential prompt will appear (a window, or inline if this host has a console).'
Write-Host 'Enter the Staging e-mail address as the user name.'
Write-Host ''

$credential = Get-Credential -Message 'BELLO Staging (bello-inventory-staging) sign-in'
if ($null -eq $credential) {
    Write-Host 'Cancelled. Nothing was stored.' -ForegroundColor Yellow
    exit 1
}

$userName = $credential.UserName
if ([string]::IsNullOrWhiteSpace($userName)) {
    Write-Host 'The user name was empty. Nothing was stored.' -ForegroundColor Yellow
    exit 1
}
if ($credential.Password.Length -eq 0) {
    Write-Host 'The password was empty. Nothing was stored.' -ForegroundColor Yellow
    exit 1
}

Set-BelloCredential -UserName $userName -Password $credential.Password

# Read it straight back before claiming success.
$check = Get-BelloCredential
if ($null -eq $check) {
    Write-Host ''
    Write-Host 'FAILED: the credential was written but cannot be read back.' -ForegroundColor Red
    Write-Host '  Nothing usable was stored. Please report this output.' -ForegroundColor Red
    exit 1
}
if ($check.UserName -ne $userName) {
    Write-Host ''
    Write-Host 'FAILED: read-back returned a different user than was written.' -ForegroundColor Red
    exit 1
}

Write-Host ''
Write-Host 'Stored, and verified by reading it back.' -ForegroundColor Green
Write-Host ('  User    : ' + $check.UserName)
Write-Host ('  Password: (' + $check.Password.Length + ' characters; value not shown)')
Write-Host '  The password was not printed and was not written to any log.'
Write-Host ''
Write-Host 'Claude Code can now sign in to Staging without any further input.'
Write-Host ''

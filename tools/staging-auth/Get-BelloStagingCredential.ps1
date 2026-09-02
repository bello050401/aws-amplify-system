<#
    Emit the stored Staging credential as one line of JSON on stdout.

    CALLED ONLY BY e2e/auth/credentialStore.ts. There is no reason for a
    person to run this: doing so prints the password to the terminal.

    When nothing is stored it prints {"found":false} and exits 0 -
    "not stored yet" is a state the caller reports, not a crash.
#>
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Import-Module (Join-Path $PSScriptRoot 'BelloCredential.psm1') -Force

$cred = Get-BelloCredential
if ($null -eq $cred) {
    [Console]::Out.Write((@{ found = $false } | ConvertTo-Json -Compress))
    exit 0
}

[Console]::Out.Write((@{
    found    = $true
    username = $cred.UserName
    password = $cred.Password
} | ConvertTo-Json -Compress))

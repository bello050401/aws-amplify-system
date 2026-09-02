<#
    BELLO Staging authentication - Windows Credential Manager access
    ================================================================

    Reads and writes ONE generic credential in the Windows Credential
    Manager through the Win32 CredRead / CredWrite / CredDelete APIs via
    P/Invoke. No PowerShell module needs to be installed from the gallery,
    which matters: this machine runs Windows PowerShell 5.1, and pulling a
    module off the internet to hold a password is an extra trust decision
    nobody asked for.

    WHY CREDENTIAL MANAGER RATHER THAN A FILE

    Windows stores the blob against the current user account, protected by
    DPAPI. It is never plaintext on disk, another user on this machine
    cannot read it, and it does not travel with the repository. A .env
    file - even a gitignored one - fails all three.

    WHAT THIS MODULE DELIBERATELY DOES NOT DO

      * It never writes the password to a file, a log, or the console.
        Get-BelloStagingCredential.ps1 emits JSON on stdout for exactly one
        caller to consume in memory; that is the only way out.
      * It never accepts a password as a command-line argument. Arguments
        land in PSReadLine history and are visible to other processes while
        the command runs. The password only ever arrives through
        Read-Host -AsSecureString.
      * It has no "list every credential" verb. It knows one target name.

    SCOPE

    The stored credential is for the BELLO **Staging** Amplify app only.
    The target name says "staging" so a future Production credential can
    never be confused with it.

    ENCODING: ASCII only, CRLF. See tools/staging-auth/.gitattributes.
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Visible in `cmdkey /list` under this name. The name alone reveals only
# "this machine can sign in to BELLO staging".
$script:CredentialTarget = 'BELLO/staging/inventory'

$script:CredTypeGeneric = 1
$script:CredPersistLocalMachine = 2

if (-not ('Bello.CredentialInterop' -as [type])) {
    Add-Type -Namespace 'Bello' -Name 'CredentialInterop' -MemberDefinition @'
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct CREDENTIAL
    {
        public uint Flags;
        public uint Type;
        public string TargetName;
        public string Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public uint CredentialBlobSize;
        public IntPtr CredentialBlob;
        public uint Persist;
        public uint AttributeCount;
        public IntPtr Attributes;
        public string TargetAlias;
        public string UserName;
    }

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode, EntryPoint = "CredReadW")]
    public static extern bool CredRead(string target, uint type, uint reservedFlag, out IntPtr credentialPtr);

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode, EntryPoint = "CredWriteW")]
    public static extern bool CredWrite(ref CREDENTIAL userCredential, uint flags);

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode, EntryPoint = "CredDeleteW")]
    public static extern bool CredDelete(string target, uint type, uint flags);

    [DllImport("advapi32.dll", SetLastError = false)]
    public static extern void CredFree(IntPtr buffer);
'@
}

function Get-BelloCredentialTarget {
    [CmdletBinding()]
    param()
    return $script:CredentialTarget
}

function Set-BelloCredential {
    <#
        .SYNOPSIS
        Store the Staging sign-in for the current Windows user.

        .DESCRIPTION
        The password arrives as a SecureString and is converted to plain
        text only inside this function, only long enough to hand the bytes
        to CredWrite. The unmanaged copy is zeroed before it is freed, so
        the password does not linger in a released heap block.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$UserName,
        [Parameter(Mandatory = $true)][System.Security.SecureString]$Password
    )

    $bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($Password)
    try {
        $plain = [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
        $bytes = [System.Text.Encoding]::Unicode.GetBytes($plain)
        $blob = [System.Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length)
        try {
            [System.Runtime.InteropServices.Marshal]::Copy($bytes, 0, $blob, $bytes.Length)

            $cred = New-Object 'Bello.CredentialInterop+CREDENTIAL'
            $cred.Flags = 0
            $cred.Type = $script:CredTypeGeneric
            $cred.TargetName = $script:CredentialTarget
            $cred.Comment = 'BELLO Staging (Amplify) inventory sign-in. Staging only - never reuse for Production.'
            $cred.CredentialBlobSize = [uint32]$bytes.Length
            $cred.CredentialBlob = $blob
            $cred.Persist = $script:CredPersistLocalMachine
            $cred.AttributeCount = 0
            $cred.Attributes = [IntPtr]::Zero
            $cred.TargetAlias = $null
            $cred.UserName = $UserName

            if (-not [Bello.CredentialInterop]::CredWrite([ref]$cred, 0)) {
                $code = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
                throw "CredWrite failed (Win32 error $code)."
            }
        }
        finally {
            $zero = New-Object byte[] $bytes.Length
            [System.Runtime.InteropServices.Marshal]::Copy($zero, 0, $blob, $bytes.Length)
            [System.Runtime.InteropServices.Marshal]::FreeHGlobal($blob)
            [Array]::Clear($bytes, 0, $bytes.Length)
        }
    }
    finally {
        [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    }
}

function Get-BelloCredential {
    <#
        .SYNOPSIS
        Return @{ UserName; Password } for the stored sign-in, or $null.

        .DESCRIPTION
        Returns plain text on purpose: the single caller
        (Get-BelloStagingCredential.ps1) serialises it to stdout for the
        Playwright helper, which holds it in memory and never persists it.
        Nothing else may call this.
    #>
    [CmdletBinding()]
    param()

    $ptr = [IntPtr]::Zero
    if (-not [Bello.CredentialInterop]::CredRead($script:CredentialTarget, $script:CredTypeGeneric, 0, [ref]$ptr)) {
        $code = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
        # 1168 = ERROR_NOT_FOUND. "Not stored yet" is a state, not a failure.
        if ($code -eq 1168) { return $null }
        throw "CredRead failed (Win32 error $code)."
    }

    try {
        $cred = [System.Runtime.InteropServices.Marshal]::PtrToStructure($ptr, [type]'Bello.CredentialInterop+CREDENTIAL')
        $password = ''
        if ($cred.CredentialBlobSize -gt 0) {
            $chars = [int]($cred.CredentialBlobSize / 2)
            $password = [System.Runtime.InteropServices.Marshal]::PtrToStringUni($cred.CredentialBlob, $chars)
        }
        return @{ UserName = $cred.UserName; Password = $password }
    }
    finally {
        [Bello.CredentialInterop]::CredFree($ptr)
    }
}

function Remove-BelloCredential {
    <# Delete the stored credential. Returns $false when nothing was stored. #>
    [CmdletBinding()]
    param()
    if (-not [Bello.CredentialInterop]::CredDelete($script:CredentialTarget, $script:CredTypeGeneric, 0)) {
        $code = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
        if ($code -eq 1168) { return $false }
        throw "CredDelete failed (Win32 error $code)."
    }
    return $true
}

Export-ModuleMember -Function Get-BelloCredentialTarget, Set-BelloCredential, Get-BelloCredential, Remove-BelloCredential

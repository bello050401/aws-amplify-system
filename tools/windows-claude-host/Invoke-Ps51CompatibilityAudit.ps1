<#
.SYNOPSIS
    Static audit of this toolkit for Windows PowerShell 5.1 compatibility.

.DESCRIPTION
    Parses every .ps1 in a directory and reports constructs that work in
    PowerShell 7 but break, or behave differently, under Windows PowerShell
    5.1 - which is what `powershell.exe -File script.ps1` runs on Windows.

    Checks:
      PS51-001  $PSScriptRoot / $PSCommandPath / $MyInvocation used inside a
                param() default value. These are evaluated before the script
                body and are EMPTY when the script is dot-sourced, run through
                Invoke-Expression, executed from an editor selection, or
                hosted without a script context - producing
                "Cannot bind argument to parameter 'Path' because it is an
                empty string" before any of your code runs.
      PS51-002  Ternary operator  a ? b : c                (PowerShell 7+ only)
      PS51-003  Pipeline chain operators  &&  ||           (PowerShell 7+ only)
      PS51-004  Null-coalescing / null-conditional  ?? ??= ?. ?[]  (7+ only)
      PS51-005  $IsWindows / $IsLinux / $IsMacOS - undefined in 5.1, so an
                `if ($IsWindows)` silently evaluates to false
      PS51-006  Cmdlets that do not exist in Windows PowerShell 5.1
      PS51-007  -Encoding values that 5.1 does not accept
                (utf8NoBOM, utf8BOM, ansi)
      PS51-008  Parameters added after 5.1 on otherwise-valid cmdlets
      PS51-009  Non-ASCII bytes in a .ps1 without a BOM. Windows PowerShell
                5.1 reads such a file as ANSI, corrupting the characters.
      PS51-010  #requires -Version above 5.1
      PS51-011  Join-Path / Split-Path whose Path argument is an environment
                variable that is not guarded against being empty by an
                enclosing if. An unset variable produces
                "Cannot bind argument to parameter 'Path' because it is an
                empty string" at runtime.

    This must be run with PowerShell 7 (its parser understands the 7-only
    syntax it is looking for). It changes nothing.

.EXAMPLE
    pwsh -NoProfile -File .\Invoke-Ps51CompatibilityAudit.ps1
#>
[CmdletBinding()]
param(
    [string] $Path,
    [switch] $Quiet
)

$ErrorActionPreference = 'Stop'

# Resolve the directory to audit without relying on $PSScriptRoot in a default.
$auditDir = $Path
if ([string]::IsNullOrWhiteSpace($auditDir)) {
    if (-not [string]::IsNullOrWhiteSpace($PSScriptRoot)) { $auditDir = $PSScriptRoot }
    elseif (-not [string]::IsNullOrWhiteSpace($PSCommandPath)) { $auditDir = Split-Path -Parent $PSCommandPath }
    else { $auditDir = (Get-Location).ProviderPath }
}

$findings = New-Object System.Collections.ArrayList
function Add-Finding {
    param([string]$Rule, [string]$File, [int]$Line, [string]$Message, [string]$Severity = 'ERROR')
    [void]$findings.Add([pscustomobject]@{
        Severity = $Severity; Rule = $Rule; File = $File; Line = $Line; Message = $Message
    })
}

$missingIn51 = @(
    'ConvertFrom-Markdown', 'Get-Error', 'Get-Uptime', 'Join-String', 'Test-Json',
    'Remove-Alias', 'Select-String -Raw', 'ConvertTo-CliXml', 'ConvertFrom-CliXml',
    'Invoke-DscResource', 'Get-SecureRandom'
)

foreach ($file in (Get-ChildItem -LiteralPath $auditDir -Filter '*.ps1' -File | Sort-Object Name)) {

    # --- PS51-009: encoding -------------------------------------------------
    $bytes = [System.IO.File]::ReadAllBytes($file.FullName)
    $hasBom = ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
    $nonAscii = $false
    foreach ($b in $bytes) { if ($b -gt 0x7F) { $nonAscii = $true; break } }
    if ($nonAscii -and -not $hasBom) {
        Add-Finding -Rule 'PS51-009' -File $file.Name -Line 1 -Severity 'ERROR' `
            -Message 'File contains non-ASCII bytes but has no UTF-8 BOM; Windows PowerShell 5.1 will read it as ANSI and corrupt those characters. Keep .ps1 files ASCII-only, or save them as UTF-8 with BOM.'
    }

    # --- parse --------------------------------------------------------------
    $tokens = $null; $errors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseFile($file.FullName, [ref]$tokens, [ref]$errors)
    if ($errors -and $errors.Count) {
        foreach ($e in $errors) {
            Add-Finding -Rule 'PARSE' -File $file.Name -Line $e.Extent.StartLineNumber -Severity 'ERROR' -Message $e.Message
        }
        continue
    }

    # --- PS51-001: script-location variables in param() defaults ------------
    $paramBlocks = $ast.FindAll({ $args[0] -is [System.Management.Automation.Language.ParamBlockAst] }, $true)
    foreach ($pb in $paramBlocks) {
        foreach ($p in $pb.Parameters) {
            if ($null -eq $p.DefaultValue) { continue }
            $vars = $p.DefaultValue.FindAll({ $args[0] -is [System.Management.Automation.Language.VariableExpressionAst] }, $true)
            foreach ($v in $vars) {
                if ($v.VariablePath.UserPath -in @('PSScriptRoot', 'PSCommandPath', 'MyInvocation')) {
                    Add-Finding -Rule 'PS51-001' -File $file.Name -Line $p.Extent.StartLineNumber -Severity 'ERROR' `
                        -Message ("parameter -{0} defaults to an expression using `${1}. Move this out of param() and resolve it in the script body." -f $p.Name.VariablePath.UserPath, $v.VariablePath.UserPath)
                }
            }
        }
    }

    # --- PS51-002/003/004: PowerShell 7-only syntax -------------------------
    $allAst = $ast.FindAll({ $true }, $true)
    foreach ($node in $allAst) {
        $typeName = $node.GetType().Name
        if ($typeName -eq 'TernaryExpressionAst') {
            Add-Finding -Rule 'PS51-002' -File $file.Name -Line $node.Extent.StartLineNumber `
                -Message 'ternary operator "? :" is PowerShell 7+ only; use if/else'
        }
        if ($typeName -eq 'PipelineChainAst') {
            Add-Finding -Rule 'PS51-003' -File $file.Name -Line $node.Extent.StartLineNumber `
                -Message 'pipeline chain operator "&&" / "||" is PowerShell 7+ only'
        }
        if ($typeName -eq 'BinaryExpressionAst' -and $node.Operator -in @('QuestionQuestion', 'QuestionQuestionEquals')) {
            Add-Finding -Rule 'PS51-004' -File $file.Name -Line $node.Extent.StartLineNumber `
                -Message 'null-coalescing operator "??" is PowerShell 7+ only'
        }
        if ($node.PSObject.Properties.Name -contains 'NullConditional' -and $node.NullConditional) {
            Add-Finding -Rule 'PS51-004' -File $file.Name -Line $node.Extent.StartLineNumber `
                -Message 'null-conditional access "?." / "?[]" is PowerShell 7+ only'
        }
        # --- PS51-005 ------------------------------------------------------
        if ($typeName -eq 'VariableExpressionAst' -and
            $node.VariablePath.UserPath -in @('IsWindows', 'IsLinux', 'IsMacOS', 'IsCoreCLR')) {
            Add-Finding -Rule 'PS51-005' -File $file.Name -Line $node.Extent.StartLineNumber `
                -Message ("`${0} does not exist in Windows PowerShell 5.1 and evaluates to `$null there" -f $node.VariablePath.UserPath)
        }
    }

    # --- PS51-006/007/008: commands and parameters --------------------------
    $commands = $ast.FindAll({ $args[0] -is [System.Management.Automation.Language.CommandAst] }, $true)
    foreach ($c in $commands) {
        $name = $c.GetCommandName()
        if ($name -and ($missingIn51 -contains $name)) {
            Add-Finding -Rule 'PS51-006' -File $file.Name -Line $c.Extent.StartLineNumber `
                -Message ("cmdlet '{0}' does not exist in Windows PowerShell 5.1" -f $name)
        }
        $elements = $c.CommandElements
        for ($i = 0; $i -lt $elements.Count; $i++) {
            $el = $elements[$i]
            if ($el -isnot [System.Management.Automation.Language.CommandParameterAst]) { continue }
            $pName = $el.ParameterName
            $nextText = ''
            if ($i + 1 -lt $elements.Count) { $nextText = $elements[$i + 1].Extent.Text.Trim("'", '"') }

            if ($pName -eq 'Encoding' -and $nextText -in @('utf8NoBOM', 'utf8BOM', 'ansi')) {
                Add-Finding -Rule 'PS51-007' -File $file.Name -Line $el.Extent.StartLineNumber `
                    -Message ("-Encoding {0} is not accepted by Windows PowerShell 5.1" -f $nextText)
            }
            if ($name -eq 'Get-ChildItem' -and $pName -eq 'FollowSymlink') {
                Add-Finding -Rule 'PS51-008' -File $file.Name -Line $el.Extent.StartLineNumber `
                    -Message '-FollowSymlink was added after Windows PowerShell 5.1'
            }
            if ($name -eq 'ConvertFrom-Json' -and $pName -eq 'AsHashtable') {
                Add-Finding -Rule 'PS51-008' -File $file.Name -Line $el.Extent.StartLineNumber `
                    -Message '-AsHashtable was added after Windows PowerShell 5.1'
            }
            if ($name -eq 'Test-Connection' -and $pName -eq 'TargetName') {
                Add-Finding -Rule 'PS51-008' -File $file.Name -Line $el.Extent.StartLineNumber `
                    -Message '-TargetName was added after Windows PowerShell 5.1'
            }
            if ($name -in @('Start-Process') -and $pName -eq 'Environment') {
                Add-Finding -Rule 'PS51-008' -File $file.Name -Line $el.Extent.StartLineNumber `
                    -Message '-Environment was added after Windows PowerShell 5.1'
            }
        }
    }

    # --- PS51-011: unguarded environment variable feeding a path cmdlet -----
    foreach ($c in $commands) {
        $name = $c.GetCommandName()
        if ($name -notin @('Join-Path', 'Split-Path')) { continue }
        $elements = $c.CommandElements
        if ($elements.Count -lt 2) { continue }

        # First positional argument after the command name.
        $pathArg = $null
        for ($i = 1; $i -lt $elements.Count; $i++) {
            if ($elements[$i] -is [System.Management.Automation.Language.CommandParameterAst]) { continue }
            $pathArg = $elements[$i]; break
        }
        if ($null -eq $pathArg) { continue }

        $envVars = $pathArg.FindAll({
            $args[0] -is [System.Management.Automation.Language.VariableExpressionAst] -and
            $args[0].VariablePath.IsDriveQualified -and
            $args[0].VariablePath.DriveName -eq 'env'
        }, $true)
        if ($envVars.Count -eq 0) { continue }

        foreach ($ev in $envVars) {
            $varText = $ev.Extent.Text
            # Guarded if any enclosing if-statement condition mentions this variable.
            $guarded = $false
            $parent = $c.Parent
            while ($null -ne $parent) {
                if ($parent -is [System.Management.Automation.Language.IfStatementAst]) {
                    foreach ($clause in $parent.Clauses) {
                        if ($clause.Item1.Extent.Text -like ('*' + $varText + '*')) { $guarded = $true; break }
                    }
                }
                if ($guarded) { break }
                $parent = $parent.Parent
            }
            if (-not $guarded) {
                Add-Finding -Rule 'PS51-011' -File $file.Name -Line $c.Extent.StartLineNumber -Severity 'WARN' `
                    -Message ("{0} uses {1} as a path without checking it is non-empty; if that variable is unset the call fails to bind the Path parameter at runtime." -f $name, $varText)
            }
        }
    }

    # --- PS51-010 -----------------------------------------------------------
    foreach ($t in $tokens) {
        if ($t.Kind -eq 'Comment' -and $t.Text -match '(?im)^\s*#requires\s+.*-Version\s+([0-9]+(\.[0-9]+)?)') {
            if ([double]$Matches[1] -gt 5.1) {
                Add-Finding -Rule 'PS51-010' -File $file.Name -Line $t.Extent.StartLineNumber `
                    -Message ("#requires -Version {0} excludes Windows PowerShell 5.1" -f $Matches[1])
            }
        }
    }
}

$errorsFound = @($findings | Where-Object { $_.Severity -eq 'ERROR' })
$warnings    = @($findings | Where-Object { $_.Severity -eq 'WARN' })

if (-not $Quiet) {
    Write-Host "`nWindows PowerShell 5.1 compatibility audit" -ForegroundColor Cyan
    Write-Host "Directory: $auditDir"
    Write-Host ("Files    : {0}" -f (Get-ChildItem -LiteralPath $auditDir -Filter '*.ps1' -File).Count)
    if ($findings.Count -eq 0) {
        Write-Host "`nNo issues found." -ForegroundColor Green
    } else {
        Write-Host ''
        foreach ($f in ($findings | Sort-Object File, Line)) {
            $color = if ($f.Severity -eq 'ERROR') { 'Red' } else { 'Yellow' }
            Write-Host ("[{0}] {1}  {2}:{3}" -f $f.Severity, $f.Rule, $f.File, $f.Line) -ForegroundColor $color
            Write-Host ("        {0}" -f $f.Message)
        }
    }
    Write-Host ("`nErrors: {0}   Warnings: {1}" -f $errorsFound.Count, $warnings.Count)
}

if ($errorsFound.Count -gt 0) { exit 1 } else { exit 0 }

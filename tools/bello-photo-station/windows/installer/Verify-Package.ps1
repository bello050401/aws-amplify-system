param([Parameter(Mandatory)][string]$PayloadDir)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$payload = (Resolve-Path -LiteralPath $PayloadDir).Path
foreach ($required in @('PhotoStation.Desktop.exe','node.exe','Node-LICENSE.txt','.NET-LICENSE.txt','.NET-ThirdPartyNotices.txt','pipeline/src/cli.mjs','pipeline/src/validationLogin.mjs','pipeline/assets/BelloStamp.png','pipeline/node_modules/sharp/package.json','lightroom/BelloPhotoStation.lrplugin/Info.lua','Install-LightroomBridge.ps1','お読みください.txt','package-manifest.json','.bello-photo-install')) {
    if (!(Test-Path -LiteralPath (Join-Path $payload $required) -PathType Leaf)) { throw "Missing payload file: $required" }
}
foreach ($item in Get-ChildItem -LiteralPath $payload -Recurse -Force) {
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Package contains a link or junction.' }
    $relative = [IO.Path]::GetRelativePath($payload,$item.FullName).Replace('\','/')
    if ($relative -match '(^|/)(\.aws|\.git|\.env[^/]*|credentials|history\.json|station\.sqlite[^/]*|validation-refresh\.dpapi|sessions)(/|$)' -or $relative -match '\.(arw|cr2|nef|jpe?g|har|pem|pfx|dpapi|sqlite|db)$') { throw "Prohibited package entry: $relative" }
}
$manifest = Get-Content -LiteralPath (Join-Path $payload 'package-manifest.json') -Raw | ConvertFrom-Json
$seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
foreach ($entry in $manifest) {
    if (!$seen.Add($entry.path) -or [IO.Path]::IsPathRooted($entry.path) -or $entry.path -match '(^|/)\.\.(/|$)') { throw 'Invalid manifest path.' }
    $file = Join-Path $payload $entry.path
    if (!(Test-Path -LiteralPath $file -PathType Leaf) -or (Get-Item -LiteralPath $file).Length -ne $entry.bytes -or (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ne $entry.sha256) { throw "Manifest mismatch: $($entry.path)" }
}
$actual = @(Get-ChildItem -LiteralPath $payload -File -Recurse -Force)
if ($actual.Count -ne $seen.Count + 1) { throw 'Unmanifested package files detected.' }
$node = Join-Path $payload 'node.exe'
# The distributed launcher uses Windows PowerShell 5.1, not PowerShell 7.
# Parse the actual packaged scripts with that engine to catch encoding failures.
$windowsPowerShell = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
foreach ($script in Get-ChildItem -LiteralPath $payload -Filter '*.ps1' -File) {
    $scriptLiteral = "'" + $script.FullName.Replace("'", "''") + "'"
    $parseCommand = '$tokens=$null; $errors=$null; [System.Management.Automation.Language.Parser]::ParseFile(' + $scriptLiteral + ',[ref]$tokens,[ref]$errors) | Out-Null; if($errors.Count){$errors | ForEach-Object {$_.ErrorId}; exit 1}; exit 0'
    $encodedCommand = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($parseCommand))
    & $windowsPowerShell -NoProfile -NonInteractive -EncodedCommand $encodedCommand
    if ($LASTEXITCODE -ne 0) { throw "Windows PowerShell cannot parse the packaged script: $($script.Name)" }
}
$sharpDir = Join-Path $payload 'pipeline/node_modules/sharp'
& $node -e 'const sharp=require(process.argv[1]);(async()=>{const out=await sharp({create:{width:2,height:3,channels:3,background:"#123456"}}).rotate(90).jpeg().toBuffer();const meta=await sharp(out).metadata();if(meta.width!==3||meta.height!==2)throw Error("Image processing failed");console.log("Bundled Node + sharp: PASS");})().catch(e=>{console.error(e.message);process.exit(1)});' $sharpDir
if ($LASTEXITCODE -ne 0) { throw 'Bundled image runtime failed.' }
foreach ($script in Get-ChildItem -LiteralPath (Join-Path $payload 'pipeline/src') -Filter '*.mjs' -File) {
    & $node --check $script.FullName
    if ($LASTEXITCODE -ne 0) { throw "Invalid pipeline module: $($script.Name)" }
}
Write-Output "Verified $($seen.Count) payload files; no user data, credential files, or links."

<#
.SYNOPSIS
  Build sharp for linux-x64 (glibc) and publish it as a Lambda layer.

.DESCRIPTION
  Why this exists
  ---------------
  amplify/functions/image-processing-worker and zaico-sync-worker both use
  sharp. sharp needs a native addon (the .node binary inside
  @img/sharp-linux-x64), which esbuild cannot fold into a bundle. When
  those two functions were deployed for the very first time (build job
  #65), every scheduled invocation died at INIT:

      Error: Could not load the "sharp" module using the linux-x64 runtime
        at file:///var/task/index.mjs:60:239185

  The stack position shows sharp had been inlined into index.mjs. No
  bundler setting fixes that - the native binary has to ship separately.

  The fix is to keep sharp out of the bundle and supply it from a Lambda
  layer at /opt/nodejs/node_modules/sharp. Amplify Gen2 does both with a
  single `layers` property: @aws-amplify/backend-function passes
  `externalModules: Object.keys(props.layers)` to esbuild, so writing the
  key `sharp` is itself the instruction to externalize it, while the value
  points at the layer that provides the real thing.

  This layer is a prerequisite that CDK does not manage. Run this script
  before `ampx pipeline-deploy` when deploying into a new AWS account or
  region for the first time, or after bumping sharp in package.json.

  Idempotency
  -----------
  publish-layer-version always mints a new version and cannot overwrite an
  existing one. So if a layer for the same sharp version already exists,
  this script reports it and exits without publishing. Use -Force to
  publish a new version anyway.

.PARAMETER Profile
  AWS CLI profile to use. Defaults to Bello.

.PARAMETER Region
  Region to publish into. Must match the Amplify app's region.

.PARAMETER LayerName
  Layer name. Must match the value used in resource.ts `layers`.

.PARAMETER Force
  Publish a new version even if one for this sharp version already exists.

.EXAMPLE
  ./scripts/aws-setup/9-publish-sharp-layer.ps1
  ./scripts/aws-setup/9-publish-sharp-layer.ps1 -Force
#>
[CmdletBinding()]
param(
  [string]$Profile = "Bello",
  [string]$Region = "us-west-2",
  [string]$LayerName = "bello-sharp-linux-x64",
  [switch]$Force
)

$ErrorActionPreference = "Stop"
$env:AWS_PAGER = ""
# Keep the AWS CLI from crashing when it prints non-ASCII to a cp932
# console - a failure mode this repo has already hit once (see commit
# acb76e4, where a cp932 print crash was misread as "secret not found").
$env:PYTHONIOENCODING = "utf-8"
$env:PYTHONUTF8 = "1"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$pkg = Get-Content (Join-Path $repoRoot "package.json") -Raw | ConvertFrom-Json
$sharpRange = $pkg.dependencies.sharp
if (-not $sharpRange) { throw "sharp is not listed in package.json dependencies." }
# "^0.35.4" -> "0.35.4". The layer and the application must agree on the
# sharp version: a mismatch between the native binary and the JS wrapper
# fails at runtime, so always pin the layer to what package.json declares.
$sharpVersion = $sharpRange -replace '^[\^~>=<\s]+', ''
Write-Output "package.json sharp: $sharpRange -> layer will contain: $sharpVersion"

# --- Check for an existing layer -------------------------------------
$existing = aws lambda list-layer-versions --layer-name $LayerName `
  --profile $Profile --region $Region --no-cli-pager `
  --query "LayerVersions[0].{v:Version,desc:Description}" --output json 2>$null
if ($LASTEXITCODE -eq 0 -and $existing -and $existing -ne "null") {
  $e = $existing | ConvertFrom-Json
  if ($e.desc -like "*$sharpVersion*" -and -not $Force) {
    Write-Output "A layer for sharp $sharpVersion already exists: ${LayerName}:$($e.v)"
    Write-Output "Use this in resource.ts:  layers: { sharp: `"${LayerName}:$($e.v)`" }"
    Write-Output "(pass -Force to publish a new version anyway)"
    exit 0
  }
}

# --- Install sharp for linux-x64 -------------------------------------
# --os/--cpu/--libc make npm fetch the prebuilt binaries for Lambda
# (Amazon Linux 2023, glibc, x86_64) even when running on Windows.
$work = Join-Path ([System.IO.Path]::GetTempPath()) "bello-sharp-layer-$(Get-Random)"
$nodejs = Join-Path $work "nodejs"
New-Item -ItemType Directory -Force -Path $nodejs | Out-Null
try {
  Push-Location $nodejs
  npm init -y | Out-Null
  Write-Output "Installing sharp@$sharpVersion for linux-x64..."
  npm install --os=linux --cpu=x64 --libc=glibc --omit=dev "sharp@$sharpVersion" 2>&1 | Select-Object -Last 3
  if ($LASTEXITCODE -ne 0) { throw "npm install of sharp failed." }
  Pop-Location

  # Verify the native binary really landed. Skipping this check would let
  # the script publish an empty-in-practice layer, leaving the Lambdas
  # failing at INIT with the exact same error this script exists to fix.
  $nativeBinary = Get-ChildItem $nodejs -Recurse -Filter "*.node" -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -like "*sharp-linux-x64*" } | Select-Object -First 1
  if (-not $nativeBinary) {
    throw "No linux-x64 native binary found under @img/sharp-linux-x64. Refusing to publish."
  }
  Write-Output ("Native binary present: {0} ({1:N1} MB)" -f $nativeBinary.Name, ($nativeBinary.Length / 1MB))

  # --- Zip -----------------------------------------------------------
  # A Lambda layer zip must have nodejs/node_modules/... at its root.
  $zipPath = Join-Path $work "layer.zip"
  Compress-Archive -Path $nodejs -DestinationPath $zipPath -CompressionLevel Optimal
  $zipInfo = Get-Item $zipPath
  Write-Output ("Zip size: {0:N1} MB (direct upload limit is 50 MB)" -f ($zipInfo.Length / 1MB))
  if ($zipInfo.Length -gt 50MB) {
    throw "Zip exceeds 50 MB; switch to publishing via an S3 object instead."
  }

  # --- Publish -------------------------------------------------------
  $desc = "sharp $sharpVersion prebuilt for linux-x64 (glibc) - used by BELLO image-processing-worker and zaico-sync-worker"
  $result = aws lambda publish-layer-version `
    --layer-name $LayerName `
    --description $desc `
    --zip-file "fileb://$zipPath" `
    --compatible-runtimes nodejs22.x `
    --compatible-architectures x86_64 `
    --profile $Profile --region $Region --no-cli-pager `
    --query "{arn:LayerVersionArn,version:Version}" --output json
  if ($LASTEXITCODE -ne 0) { throw "publish-layer-version failed." }

  $r = $result | ConvertFrom-Json
  Write-Output ""
  Write-Output "Published: $($r.arn)"
  Write-Output "Set this in amplify/functions/*/resource.ts:"
  Write-Output "    layers: { sharp: `"${LayerName}:$($r.version)`" }"
}
finally {
  if ((Get-Location).Path -eq $nodejs) { Pop-Location }
  Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
}

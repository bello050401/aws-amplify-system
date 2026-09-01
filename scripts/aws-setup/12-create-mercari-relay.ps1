<#
.SYNOPSIS
  Mercari Shops API 中継サーバー(Lightsail / 東京)を作成する。冪等。

.DESCRIPTION
  なぜ必要か
  ----------
  Mercari Shops APIは「日本国内の固定IPアドレス(他社と共有していないもの、
  範囲指定不可)」からのリクエストしか受け付けない。BELLO本体は
  Amplify Hosting のSSRコンピュート上で動き、**顧客VPCへ接続できない**
  (`aws amplify update-app/update-branch` にVPC系パラメータが存在しない)ため、
  NAT Gateway + Elastic IP を作っても送信元IPは固定できない。
  したがってMercari呼び出しだけを東京の小さな常時稼働インスタンスへ移す。
  設計の全体像は docs/mercari-relay-design-20260901.md を参照。

  作るもの
  --------
    1. Lightsail 静的IP    bello-mercari-relay-ip   (インスタンスとは独立)
    2. Lightsail インスタンス bello-mercari-relay    (nano_3_0 / ubuntu_24_04)
    3. Lightsail ファイアウォール(443のみ公開。22はブラウザSSHのみ)
    4. Secrets Manager     bello/mercari-relay      (us-west-2)
    5. 既存IAMポリシー BelloComputeRuntimeAccess へ Resource を1本追加

  静的IPを**インスタンスとは別のリソースとして**確保するのが要点。
  インスタンスを作り直してもIPが変わらず、Mercariへの再申請が不要になる。

  冪等性
  ------
  既に存在するものは作り直さない。特に静的IPは、既にあれば**絶対に
  解放しない**(解放するとそのIPは二度と戻らず、Mercariへの再申請が必要になる)。

  秘密情報の扱い
  --------------
  - CA秘密鍵は Secrets Manager にのみ保管し、**中継サーバーには置かない**。
  - サーバー秘密鍵はuser-data経由で配置し、user-data内の写しは
    セットアップ完了時にインスタンス側で shred する。
  - このスクリプトは秘密値を標準出力へ一切表示しない。

.PARAMETER Recreate
  インスタンスだけを作り直す(静的IPとSecretは保持)。OS破損・更新失敗からの復旧用。

.EXAMPLE
  ./12-create-mercari-relay.ps1
  ./12-create-mercari-relay.ps1 -Recreate
#>
[CmdletBinding()]
param(
  [string]$Profile          = "Bello",
  [string]$Region           = "ap-northeast-1",
  [string]$SecretRegion     = "us-west-2",
  [string]$InstanceName     = "bello-mercari-relay",
  [string]$StaticIpName     = "bello-mercari-relay-ip",
  [string]$SecretName       = "bello/mercari-relay",
  [string]$RoleName         = "BelloAmplifyStagingComputeRole",
  [string]$PolicyName       = "BelloComputeRuntimeAccess",
  [string]$Bundle           = "nano_3_0",
  [string]$Blueprint        = "ubuntu_24_04",
  [switch]$Recreate
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)

function Info($m) { Write-Host "  $m" }
function Step($m) { Write-Host ""; Write-Host "== $m" -ForegroundColor Cyan }

# Windows PowerShell 5.1 では、ネイティブコマンドのstderrを取り込むと各行が
# ErrorRecordへ包まれ、$ErrorActionPreference='Stop' の下では終了エラーになる。
# 「存在するか確かめるだけ」の呼び出し(存在しなければAWS CLIがエラーを返すのが
# 正常な状態)はこのヘルパー経由にして、終了コードだけを見る。
function Invoke-AwsProbe {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]] $CliArgs)
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $out = (& aws @CliArgs 2>&1 | Out-String)
    return [pscustomobject]@{ ExitCode = $LASTEXITCODE; Output = $out.Trim() }
  } finally { $ErrorActionPreference = $prev }
}

# opensslはPATHに無いことがある(このマシンでは実行セッションによって見えたり
# 見えなかったりすることを実測)。PATHに頼らずフルパスで解決し、見つからなければ
# 最初に明示的に失敗する —— ここを握り潰すと、鍵が空のまま後段まで進んで
# 原因の分かりにくい失敗になる(実際にそうなった)。
# Lightsailのuser-dataは実効16KB弱しか通らない(15,769バイトでも
# InvalidInputException「exceeds the 16 KB limit」になることを実測)。
# テンプレートはリポジトリ側では**コメント付きのまま**保ち、送信直前に
# コメント行だけを落として縮める。
#
# ヒアドキュメント(<<'TAG' ... TAG)の中身は systemd unit や apt 設定
# そのものなので、絶対に触らない —— `#!/bin/bash` を含む行があり、
# 素朴な行削除だと壊れる。
function Remove-ShellComments {
  param([string]$Script)
  $out = New-Object Collections.Generic.List[string]
  $inHeredoc = $false
  $tag = $null
  $first = $true
  foreach ($line in ($Script -split "`n")) {
    if ($inHeredoc) {
      $out.Add($line)
      if ($line.Trim() -ceq $tag) { $inHeredoc = $false; $tag = $null }
      continue
    }
    $m = [regex]::Match($line, "<<'([A-Za-z0-9_]+)'")
    if ($m.Success) { $inHeredoc = $true; $tag = $m.Groups[1].Value; $out.Add($line); continue }
    if ($first) { $out.Add($line); $first = $false; continue }   # shebang は残す
    if ($line -match '^\s*#') { continue }                        # 行全体がコメント
    if ($line.Trim() -eq '') { continue }                         # 空行も落とす
    $out.Add($line)
  }
  return ($out -join "`n")
}

function Resolve-OpenSsl {
  $c = (Get-Command openssl -ErrorAction SilentlyContinue)
  if ($c) { return $c.Source }
  $candidates = @(
    (Join-Path $env:ProgramFiles 'Git\mingw64\bin\openssl.exe'),
    (Join-Path $env:ProgramFiles 'Git\usr\bin\openssl.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'Git\mingw64\bin\openssl.exe')
  )
  foreach ($p in $candidates) { if ($p -and (Test-Path $p)) { return $p } }
  throw "openssl が見つかりません。Git for Windows をインストールするか、PATHへ追加してください。"
}

# ── 0. 事前確認 ──────────────────────────────────────────────────────
Step "事前確認"
$account = (aws sts get-caller-identity --profile $Profile --query Account --output text)
if (-not $account) { throw "AWSアカウントを解決できません。SSOセッションが切れていませんか。" }
Info "アカウント : $account"
Info "リージョン : $Region (Secretsは $SecretRegion)"
$opensslExe = Resolve-OpenSsl
Info "openssl   : $opensslExe"

# Production側を触らないことを明示的に担保する。
if ($account -ne "203918843421") {
  throw "想定外のAWSアカウント($account)です。BELLOのアカウントでのみ実行してください。"
}

$branch = (git -C $repoRoot rev-parse --abbrev-ref HEAD)
Info "Gitブランチ: $branch"
if ($branch -eq "main") { throw "mainブランチでは実行しません。作業ブランチへ切り替えてください。" }

# ── 1. 静的IP(先に確保する。これがMercariへ申請する値になる) ──────────
Step "静的IPの確保"
$probe = Invoke-AwsProbe lightsail get-static-ip --static-ip-name $StaticIpName --region $Region --profile $Profile --query 'staticIp.ipAddress' --output text
$existingIp = if ($probe.ExitCode -eq 0) { $probe.Output } else { $null }
if ($existingIp -and $existingIp -ne "None") {
  Info "既に存在します: $existingIp (再利用。絶対に解放しません)"
} else {
  $al = Invoke-AwsProbe lightsail allocate-static-ip --static-ip-name $StaticIpName --region $Region --profile $Profile
  if ($al.ExitCode -ne 0) { throw "静的IPの確保に失敗しました: $($al.Output)" }
  $existingIp = (aws lightsail get-static-ip --static-ip-name $StaticIpName --region $Region --profile $Profile --query 'staticIp.ipAddress' --output text)
  Info "新規に確保しました: $existingIp"
}
$staticIp = $existingIp

# ── 2. 鍵・証明書(Secrets Managerが正。無ければ生成) ─────────────────
Step "共有鍵とTLS証明書"
$sp = Invoke-AwsProbe secretsmanager get-secret-value --secret-id $SecretName --region $SecretRegion --profile $Profile --query SecretString --output text
$secretJson = if ($sp.ExitCode -eq 0) { $sp.Output } else { $null }
$haveSecret = [bool]$secretJson

if ($haveSecret) {
  $secret = $secretJson | ConvertFrom-Json
  Info "既存のSecretを再利用します(鍵・証明書は再生成しません)"
} else {
  Info "新規に生成します"
  $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("bello-relay-" + [guid]::NewGuid().ToString("N"))
  New-Item -ItemType Directory -Path $tmp | Out-Null
  try {
    # 共有鍵: 32バイト乱数
    $bytes = New-Object byte[] 32
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $relayKey = [Convert]::ToBase64String($bytes)

    # opensslは進捗を標準エラーへ書く。5.1ではそれがErrorRecordへ包まれ、
    # ErrorActionPreference='Stop' の下では成功していても終了エラーになる。
    # このブロックの間だけ Continue にし、成否は $LASTEXITCODE で判定する。
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'

    # このマシンの openssl は Git for Windows の MSYS ビルドで、`/` で始まる
    # 引数を Windows パスへ勝手に変換する(実測: `-subj "/CN=..."` が
    # `C:/Program Files/Git/CN=...` になり証明書が作られない)。
    # そのため -subj は使わず、**設定ファイル**で主体名と拡張を渡す。
    #
    # 鍵は EC P-256。RSA2048比で鍵+証明書が約2.4KB小さくなり、
    # Lightsailのuser-data上限(16KB)へ収める上で効く。強度は十分。
    $caCnf = Join-Path $tmp "ca.cnf"
    [IO.File]::WriteAllText($caCnf, @"
[req]
distinguished_name = dn
prompt = no
x509_extensions = v3_ca
[dn]
CN = BELLO Mercari Relay CA
O = BELLO
[v3_ca]
basicConstraints = critical, CA:TRUE, pathlen:0
keyUsage = critical, keyCertSign, cRLSign
subjectKeyIdentifier = hash
"@, (New-Object Text.ASCIIEncoding))

    $srvCnf = Join-Path $tmp "server.cnf"
    [IO.File]::WriteAllText($srvCnf, @"
[req]
distinguished_name = dn
prompt = no
[dn]
CN = $staticIp
O = BELLO
[ext]
subjectAltName = IP:$staticIp
keyUsage = critical, digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
basicConstraints = critical, CA:FALSE
"@, (New-Object Text.ASCIIEncoding))

    # プライベートCA (10年)
    & $opensslExe ecparam -name prime256v1 -genkey -noout -out "$tmp/ca.key" 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { $ErrorActionPreference = $prevEap; throw "CA鍵の生成に失敗しました。opensslは利用可能ですか。" }
    & $opensslExe req -x509 -new -key "$tmp/ca.key" -sha256 -days 3650 -config $caCnf -out "$tmp/ca.crt" 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path "$tmp/ca.crt")) { $ErrorActionPreference = $prevEap; throw "CA証明書の生成に失敗しました" }

    # サーバー証明書 (IPをSANに持つ / 10年)
    & $opensslExe ecparam -name prime256v1 -genkey -noout -out "$tmp/server.key" 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { $ErrorActionPreference = $prevEap; throw "サーバー鍵の生成に失敗しました" }
    & $opensslExe req -new -key "$tmp/server.key" -sha256 -config $srvCnf -out "$tmp/server.csr" 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path "$tmp/server.csr")) { $ErrorActionPreference = $prevEap; throw "CSRの生成に失敗しました" }
    & $opensslExe x509 -req -in "$tmp/server.csr" -CA "$tmp/ca.crt" -CAkey "$tmp/ca.key" `
      -CAcreateserial -out "$tmp/server.crt" -days 3650 -sha256 `
      -extfile $srvCnf -extensions ext 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path "$tmp/server.crt")) { $ErrorActionPreference = $prevEap; throw "サーバー証明書の発行に失敗しました" }

    $ErrorActionPreference = $prevEap

    # 生成物が想定どおりか確認する(空ファイルのまま進むと、原因の分かりにくい
    # 失敗が後段で起きる)。
    foreach ($n in @("ca.crt", "ca.key", "server.crt", "server.key")) {
      $len = (Get-Item "$tmp/$n").Length
      if ($len -lt 100) { throw "$n が小さすぎます($len bytes)。証明書生成に失敗しています。" }
      Info ("  {0}: {1} bytes" -f $n, $len)
    }

    # ファイルは [IO.File]::ReadAllText で読む。`Get-Content -Raw` は
    # 文字列に PSPath / PSDrive / Provider などのプロパティを付けて返すため、
    # そのまま ConvertTo-Json へ渡すとオブジェクトグラフ全体が展開され、
    # **4.2MBのJSON**(日本語のロケール文字列入り)になってAWS CLIが
    # 「text contents could not be decoded」で失敗する —— 実際にそうなった。
    $secret = [ordered]@{
      relayKey   = $relayKey
      caCert     = [IO.File]::ReadAllText("$tmp/ca.crt")
      caKey      = [IO.File]::ReadAllText("$tmp/ca.key")     # 中継サーバーには渡さない
      serverCert = [IO.File]::ReadAllText("$tmp/server.crt")
      serverKey  = [IO.File]::ReadAllText("$tmp/server.key")
      staticIp   = $staticIp
      createdAt  = (Get-Date).ToUniversalTime().ToString("o")
    }

    $secretFile = Join-Path $tmp "secret.json"
    # PowerShell 5.1 の Set-Content -Encoding utf8 は BOM を付ける。AWS CLI は
    # file:// で渡されたBOM付きファイルを読めず ParamValidation で失敗するため、
    # BOM無しUTF-8で書く。
    [IO.File]::WriteAllText($secretFile, ($secret | ConvertTo-Json -Depth 5), (New-Object Text.UTF8Encoding($false)))
    # 説明文はASCIIのみにする(Windowsコンソールの文字コード差で
    # AWS CLIへの引数が壊れるのを避ける)。日本語の説明は設計書側にある。
    $cs = Invoke-AwsProbe secretsmanager create-secret --name $SecretName --region $SecretRegion --profile $Profile `
      --description "BELLO Mercari relay: shared HMAC key and TLS material. CA private key is stored here only, never on the relay host." `
      --secret-string "file://$secretFile"
    if ($cs.ExitCode -ne 0) { throw "Secretの作成に失敗しました: $($cs.Output)" }
    Info "Secretを作成しました: $SecretName"
    $secret = ($secret | ConvertTo-Json -Depth 5) | ConvertFrom-Json
  } finally {
    # 一時ディレクトリの秘密資材を確実に消す
    Get-ChildItem $tmp -File -ErrorAction SilentlyContinue | ForEach-Object {
      try { [System.IO.File]::WriteAllBytes($_.FullName, (New-Object byte[] $_.Length)) } catch {}
    }
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
  }
}

# 静的IPが変わっていたら証明書のSANと食い違う。作り直しが必要。
if ($secret.staticIp -and $secret.staticIp -ne $staticIp) {
  throw "Secret内の静的IP($($secret.staticIp))と現在の静的IP($staticIp)が一致しません。証明書の再発行が必要です。"
}

# ── 3. インスタンス ──────────────────────────────────────────────────
Step "インスタンス"
$ip2 = Invoke-AwsProbe lightsail get-instance --instance-name $InstanceName --region $Region --profile $Profile --query 'instance.state.name' --output text
$instState = if ($ip2.ExitCode -eq 0) { $ip2.Output } else { $null }
$instExists = ($instState -and $instState -ne "None")

if ($instExists -and $Recreate) {
  Info "-Recreate 指定: 既存インスタンスを削除します(静的IPとSecretは保持)"
  Invoke-AwsProbe lightsail detach-static-ip --static-ip-name $StaticIpName --region $Region --profile $Profile | Out-Null
  # 自動スナップショットのアドオンが有効なので --force-delete-add-ons が要る
  # (スナップショット自体は別リソースとして残り、静的IPも保持される)。
  $di = Invoke-AwsProbe lightsail delete-instance --instance-name $InstanceName --region $Region --profile $Profile --force-delete-add-ons
  if ($di.ExitCode -ne 0) { throw "インスタンスの削除に失敗しました: $($di.Output)" }
  do {
    Start-Sleep -Seconds 5
    $g = Invoke-AwsProbe lightsail get-instance --instance-name $InstanceName --region $Region --profile $Profile
  } while ($g.ExitCode -eq 0)
  $instExists = $false
}

if ($instExists) {
  Info "既に存在します(state=$instState)。作り直す場合は -Recreate を付けてください。"
} else {
  Info "user-dataを組み立てます(秘密値は表示しません)"
  # PS5.1はBOM無しUTF-8をANSIとして読む。明示しないと日本語が化け、
  # バイト数も膨れる(実測: server.mjs 11,945 -> 18,900)。
  $utf8Read = New-Object Text.UTF8Encoding($false)
  $udTemplate = [IO.File]::ReadAllText((Join-Path $PSScriptRoot "12-mercari-relay-userdata.sh"), $utf8Read)

  # Lightsailのuser-dataは16KBが上限。ファイルを個別にbase64すると約30KBに
  # なって超過するため、4ファイルをまとめてtar.gzにしてから1度だけbase64する
  # (実測 約14.4KB)。
  $stage = Join-Path ([System.IO.Path]::GetTempPath()) ("bello-relay-stage-" + [guid]::NewGuid().ToString("N"))
  New-Item -ItemType Directory -Path $stage | Out-Null
  $tgz = Join-Path ([System.IO.Path]::GetTempPath()) ("bello-relay-" + [guid]::NewGuid().ToString("N") + ".tgz")
  try {
    $utf8NoBom = New-Object Text.UTF8Encoding($false)
    # 改行はLFへ揃える(Linux側で読むため)
    [IO.File]::WriteAllText((Join-Path $stage "server.mjs"), ([IO.File]::ReadAllText((Join-Path $repoRoot "relay/server.mjs"), $utf8Read) -replace "`r`n", "`n"), $utf8NoBom)
    [IO.File]::WriteAllText((Join-Path $stage "server.crt"), ($secret.serverCert -replace "`r`n", "`n"), $utf8NoBom)
    [IO.File]::WriteAllText((Join-Path $stage "server.key"), ($secret.serverKey  -replace "`r`n", "`n"), $utf8NoBom)
    [IO.File]::WriteAllText((Join-Path $stage "relay.key"),  $secret.relayKey, $utf8NoBom)

    $prevEap2 = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    & tar -czf $tgz -C $stage server.mjs server.crt server.key relay.key 2>&1 | Out-Null
    $tarExit = $LASTEXITCODE
    $ErrorActionPreference = $prevEap2
    if ($tarExit -ne 0 -or -not (Test-Path $tgz)) { throw "ペイロードのtar.gz作成に失敗しました" }

    $payloadB64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($tgz))
    $udCompact = Remove-ShellComments -Script ($udTemplate -replace "`r`n", "`n")
    Info ("user-dataテンプレート: {0} -> {1} bytes (コメント除去後)" -f [Text.Encoding]::UTF8.GetByteCount($udTemplate), [Text.Encoding]::UTF8.GetByteCount($udCompact))
    $userData = $udCompact -replace '__PAYLOAD_TGZ_B64__', $payloadB64
    Info ("user-dataサイズ: {0} bytes (上限 16384)" -f [Text.Encoding]::UTF8.GetByteCount($userData))
    if ([Text.Encoding]::UTF8.GetByteCount($userData) -ge 16384) { throw "user-dataが16KBを超えました" }

    # AWS CLI は file:// のパラメータファイルを**マシンのロケール**
    # (この環境ではcp932)で読む。UTF-8ではない。非ASCIIが1文字でも入ると
    # 「text contents could not be decoded」で失敗する
    # (PYTHONUTF8=1 でも変わらないことを実測)。user-dataテンプレートは
    # ASCIIのみで書く決まりなので、ここで機械的に担保する。
    $nonAscii = [regex]::Matches($userData, '[^\x00-\x7F]')
    if ($nonAscii.Count -gt 0) {
      throw ("user-dataに非ASCII文字が{0}個含まれています(最初の文字: '{1}')。テンプレートはASCIIのみで書いてください。" -f $nonAscii.Count, $nonAscii[0].Value)
    }
  } finally {
    Get-ChildItem $stage -File -ErrorAction SilentlyContinue | ForEach-Object {
      try { [IO.File]::WriteAllBytes($_.FullName, (New-Object byte[] $_.Length)) } catch {}
    }
    Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
    if (Test-Path $tgz) {
      [IO.File]::WriteAllBytes($tgz, (New-Object byte[] ((Get-Item $tgz).Length)))
      Remove-Item $tgz -Force -ErrorAction SilentlyContinue
    }
  }

  $udFile = Join-Path ([System.IO.Path]::GetTempPath()) ("bello-relay-ud-" + [guid]::NewGuid().ToString("N") + ".sh")
  [System.IO.File]::WriteAllText($udFile, $userData, (New-Object Text.UTF8Encoding($false)))
  try {
    $az = "${Region}a"
    $ci = Invoke-AwsProbe lightsail create-instances --region $Region --profile $Profile `
      --instance-names $InstanceName `
      --availability-zone $az `
      --blueprint-id $Blueprint `
      --bundle-id $Bundle `
      --user-data "file://$udFile" `
      --tags "key=project,value=bello" "key=purpose,value=mercari-relay"
    if ($ci.ExitCode -ne 0) { throw "インスタンスの作成に失敗しました: $($ci.Output)" }
    Info "作成しました: $InstanceName ($Bundle / $Blueprint / $az)"
  } finally {
    if (Test-Path $udFile) {
      [System.IO.File]::WriteAllBytes($udFile, (New-Object byte[] ((Get-Item $udFile).Length)))
      Remove-Item $udFile -Force -ErrorAction SilentlyContinue
    }
  }

  Info "running になるまで待機します..."
  do {
    Start-Sleep -Seconds 10
    $instState = (aws lightsail get-instance --instance-name $InstanceName --region $Region --profile $Profile --query 'instance.state.name' --output text)
    Info "  state=$instState"
  } while ($instState -ne "running")
}

# ── 4. ファイアウォール(443のみ。22はブラウザSSHのみ) ────────────────
Step "ファイアウォール"
# 既定では22が 0.0.0.0/0 で開いている。これを削除し、
# 443(全世界)＋22(Lightsailブラウザ SSH のみ) の2つだけにする。
# cidrListAliases=lightsail-connect が「ブラウザSSHのみ許可」を意味する。
$fwJson = @'
[
  {"fromPort":443,"toPort":443,"protocol":"tcp","cidrs":["0.0.0.0/0"]},
  {"fromPort":22,"toPort":22,"protocol":"tcp","cidrs":[],"cidrListAliases":["lightsail-connect"]}
]
'@
$fwFile = Join-Path ([System.IO.Path]::GetTempPath()) ("bello-relay-fw-" + [guid]::NewGuid().ToString("N") + ".json")
[IO.File]::WriteAllText($fwFile, $fwJson, (New-Object Text.UTF8Encoding($false)))  # BOM無し(AWS CLIのfile://要件)
try {
  aws lightsail put-instance-public-ports --instance-name $InstanceName --region $Region --profile $Profile `
    --port-infos "file://$fwFile" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "ファイアウォールの設定に失敗しました" }
} finally { Remove-Item $fwFile -Force -ErrorAction SilentlyContinue }

$ports = (aws lightsail get-instance-port-states --instance-name $InstanceName --region $Region --profile $Profile --query 'portStates[].{p:fromPort,c:cidrs,a:cidrListAliases}' --output json) | ConvertFrom-Json
foreach ($p in $ports) {
  Info ("port {0}: cidrs={1} aliases={2}" -f $p.p, (($p.c -join ',') -replace '^$','(なし)'), (($p.a -join ',') -replace '^$','(なし)'))
}

# ── 5. 静的IPのアタッチ ──────────────────────────────────────────────
Step "静的IPのアタッチ"
$attached = (aws lightsail get-static-ip --static-ip-name $StaticIpName --region $Region --profile $Profile --query 'staticIp.attachedTo' --output text)
if ($attached -eq $InstanceName) {
  Info "既にアタッチ済みです"
} else {
  $at = Invoke-AwsProbe lightsail attach-static-ip --static-ip-name $StaticIpName --instance-name $InstanceName --region $Region --profile $Profile
  if ($at.ExitCode -ne 0) { throw "静的IPのアタッチに失敗しました: $($at.Output)" }
  Info "アタッチしました"
}

# ── 6. 自動スナップショット(週次相当の日次・保持は既定) ──────────────
Step "自動スナップショット"
$sn = Invoke-AwsProbe lightsail enable-add-on --resource-name $InstanceName --region $Region --profile $Profile `
  --add-on-request "addOnType=AutoSnapshot,autoSnapshotAddOnRequest={snapshotTimeOfDay=19:00}"
if ($sn.ExitCode -eq 0) { Info "有効化しました (19:00 UTC = 04:00 JST)" } else { Info "スキップしました: $($sn.Output)" }

# ── 7. SSRの実行ロールへ Secret 読み取りを追加 ───────────────────────
Step "IAM(既存ポリシーへResourceを1本追加)"
$secretArn = (aws secretsmanager describe-secret --secret-id $SecretName --region $SecretRegion --profile $Profile --query ARN --output text)
$wildcardArn = ($secretArn -replace '-[A-Za-z0-9]{6}$', '-??????')
Info "対象ARN: $wildcardArn"

$policyDoc = (aws iam get-role-policy --role-name $RoleName --policy-name $PolicyName --profile $Profile --query PolicyDocument --output json) | ConvertFrom-Json
$stmt = $policyDoc.Statement | Where-Object { $_.Sid -eq "BelloMercariAndLineSecretAccess" }
if (-not $stmt) { throw "想定したSid(BelloMercariAndLineSecretAccess)が見つかりません。手動で確認してください。" }

if ($stmt.Resource -contains $wildcardArn) {
  Info "既に許可済みです"
} else {
  $stmt.Resource = @($stmt.Resource) + $wildcardArn
  $polFile = Join-Path ([System.IO.Path]::GetTempPath()) ("bello-relay-pol-" + [guid]::NewGuid().ToString("N") + ".json")
  [IO.File]::WriteAllText($polFile, ($policyDoc | ConvertTo-Json -Depth 10), (New-Object Text.UTF8Encoding($false)))  # BOM無し
  try {
    aws iam put-role-policy --role-name $RoleName --policy-name $PolicyName --profile $Profile --policy-document "file://$polFile" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "IAMポリシーの更新に失敗しました" }
    Info "Resourceを追加しました"
  } finally { Remove-Item $polFile -Force -ErrorAction SilentlyContinue }
}

# ── 完了 ─────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "=========================================================" -ForegroundColor Green
Write-Host " 構築完了" -ForegroundColor Green
Write-Host "=========================================================" -ForegroundColor Green
Write-Host ""
Write-Host "  Mercari Shops へ登録すべき固定IPv4アドレス:" -ForegroundColor Yellow
Write-Host "      $staticIp" -ForegroundColor Yellow
Write-Host ""
Write-Host "  ※ sandbox と production の両方に、同じこのIPを申請してください。"
Write-Host "  ※ 申請が通るまで、Mercariは404を返し続けます(正常な挙動です)。"
Write-Host ""
Write-Host "  次の手順: ./12-verify-mercari-relay.ps1 で外形検証を実行"
Write-Host ""

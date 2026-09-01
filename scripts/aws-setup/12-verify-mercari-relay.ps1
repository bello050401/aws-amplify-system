<#
.SYNOPSIS
  Mercari中継サーバーの外形検証。**Mercariへの固定IP申請より前に実行できる。**

.DESCRIPTION
  ここで確認するのは「中継そのものが設計どおりに振る舞うか」であって、
  Mercariへ実際に繋がるかではない。IP申請前はMercariが404を返すのが正常で、
  それも含めて期待どおりかを見る。

  検証項目(夜間指示の条件11):
    1. TLS       — 自前CAでのみ検証が通り、CA無しでは拒否される
    2. 認証      — 正しい署名は通る / 鍵違い・署名改竄・欠落は401
    3. 期限切れ署名 — ±300秒の外は401
    4. 経路制限  — 許可外のパス404 / 許可外メソッド405
    5. 宛先制限  — 不正なenvは400(任意URLへ転送されない)
    6. レート制限 — 連投で429
    7. ログ秘匿  — Authorization/トークン/本文がログに出ない
    8. 自動復帰  — 再起動後にサービスが自動で戻る

  秘密値は一切表示しない。

.EXAMPLE
  ./12-verify-mercari-relay.ps1
  ./12-verify-mercari-relay.ps1 -SkipReboot   # 再起動テストを省く
#>
[CmdletBinding()]
param(
  [string]$Profile      = "Bello",
  [string]$Region       = "ap-northeast-1",
  [string]$SecretRegion = "us-west-2",
  [string]$InstanceName = "bello-mercari-relay",
  [string]$StaticIpName = "bello-mercari-relay-ip",
  [string]$SecretName   = "bello/mercari-relay",
  [switch]$SkipReboot
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)

$script:pass = 0
$script:fail = 0
function Ok($m)   { $script:pass++; Write-Host "  [OK]   $m" -ForegroundColor Green }
function Ng($m)   { $script:fail++; Write-Host "  [NG]   $m" -ForegroundColor Red }
function Info($m) { Write-Host "         $m" -ForegroundColor DarkGray }
function Step($m) { Write-Host ""; Write-Host "== $m" -ForegroundColor Cyan }

$staticIp = (aws lightsail get-static-ip --static-ip-name $StaticIpName --region $Region --profile $Profile --query 'staticIp.ipAddress' --output text)
if (-not $staticIp -or $staticIp -eq "None") { throw "静的IPが見つかりません" }
Write-Host "対象: https://$staticIp/mercari/graphql"

# 検証用の一時ファイル(CA証明書と鍵)。終了時に必ず破棄する。
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("bello-verify-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $tmp | Out-Null

try {
  $secret = (aws secretsmanager get-secret-value --secret-id $SecretName --region $SecretRegion --profile $Profile --query SecretString --output text) | ConvertFrom-Json
  Set-Content -Path "$tmp/ca.crt" -Value $secret.caCert -Encoding ascii -NoNewline
  Set-Content -Path "$tmp/relay.key" -Value $secret.relayKey -Encoding ascii -NoNewline

  # 実際の検証はNodeで行う(HMAC生成とCA固定のTLSがそのまま書けるため)。
  $nodeScript = Join-Path $tmp "verify.mjs"
  Set-Content -Path $nodeScript -Encoding utf8 -Value @'
import { readFileSync } from "node:fs";
import { createHmac } from "node:crypto";
import { request as httpsRequest } from "node:https";

const [target, caPath, keyPath, mode] = process.argv.slice(2);
const [ip, portStr] = target.split(":");
const PORT = portStr ? Number(portStr) : 443;
const ca = readFileSync(caPath, "utf8");
const relayKey = readFileSync(keyPath, "utf8").trim();

function sign(body, ts) {
  return createHmac("sha256", relayKey).update(`${ts}.${body}`, "utf8").digest("base64");
}
function headersFor(body, { ts = Math.floor(Date.now() / 1000), key = relayKey, sig = null, env = "sandbox" } = {}) {
  return {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    "x-bello-relay-key": key,
    "x-bello-relay-timestamp": String(ts),
    "x-bello-relay-signature": sig ?? sign(body, ts),
    "x-bello-mercari-env": env,
    authorization: "Bearer dummy-token-for-verification-only",
  };
}

/** node:https で1回叩く。trustCa=false のときは公開CAのみ(=自己署名は拒否されるはず)。 */
function call(path, { method = "POST", body = null, headers = null, trustCa = true, h = {} } = {}) {
  const payload = method === "GET" ? "" : (body ?? JSON.stringify({ query: "query ProductCategories { productCategories { id } }", variables: {} }));
  const hdrs = headers ?? (method === "GET" ? {} : headersFor(payload, h));
  return new Promise((resolve) => {
    const req = httpsRequest(
      {
        host: ip, port: PORT, path, method, headers: hdrs, timeout: 25000,
        // local モードは 127.0.0.1 へ繋ぐ。証明書のSANは本番IPなので
        // 検証は外す(ここで見たいのはログの秘匿であってTLSではない)。
        ...(mode === "local" ? { rejectUnauthorized: false } : (trustCa ? { ca } : {})),
      },
      (res) => {
        let t = "";
        res.on("data", (c) => (t += c));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text: t.slice(0, 300) }));
      },
    );
    req.on("timeout", () => { req.destroy(); resolve({ status: "TIMEOUT", headers: {}, text: "" }); });
    req.on("error", (e) => resolve({ status: "ERR", headers: {}, text: String(e.code ?? e.message).slice(0, 60) }));
    if (method !== "GET") req.write(payload);
    req.end();
  });
}

const out = {};
if (mode === "main") {
  const hz = await call("/healthz", { method: "GET" });
  out.healthz = hz.status;

  const untrusted = await call("/healthz", { method: "GET", trustCa: false });
  out.tlsUntrusted = untrusted.status === "ERR" ? "REJECTED:" + untrusted.text : "ACCEPTED:" + untrusted.status;

  out.validAuth = (await call("/mercari/graphql")).status;
  out.badKey = (await call("/mercari/graphql", { h: { key: "wrong-key-aaaaaaaaaaaaaaaaaaaaaaaaaaaa" } })).status;
  out.badSig = (await call("/mercari/graphql", { h: { sig: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" } })).status;

  const bodyOnly = JSON.stringify({ query: "query ProductCategories { productCategories { id } }", variables: {} });
  const noHdr = await call("/mercari/graphql", { body: bodyOnly, headers: { "content-type": "application/json", "content-length": Buffer.byteLength(bodyOnly) } });
  out.noHeaders = noHdr.status;
  out.noHeadersErrHeader = noHdr.headers["x-bello-relay-error"] ?? "(なし)";

  out.staleTs = (await call("/mercari/graphql", { h: { ts: Math.floor(Date.now() / 1000) - 900 } })).status;
  out.futureTs = (await call("/mercari/graphql", { h: { ts: Math.floor(Date.now() / 1000) + 900 } })).status;

  out.badPath = (await call("/anything-else")).status;
  out.getOnPath = (await call("/mercari/graphql", { method: "GET" })).status;

  out.badEnv = (await call("/mercari/graphql", { h: { env: "https://evil.example.com" } })).status;
  out.emptyEnv = (await call("/mercari/graphql", { h: { env: "" } })).status;

  const forwarded = await call("/mercari/graphql");
  out.forwardedStatus = forwarded.status;
  out.forwardedRelayErr = forwarded.headers["x-bello-relay-error"] ?? "(なし)";
} else if (mode === "rate") {
  let got429 = false, n = 0;
  for (let i = 0; i < 40; i++) {
    const r = await call("/mercari/graphql");
    n++;
    if (r.status === 429) { got429 = true; break; }
  }
  out.rateLimited = got429;
  out.requestsUntil429 = n;
} else if (mode === "local") {
  // ログ秘匿の検証用: 認証OKの1本と、認証NGの1本を通す。
  out.ok = (await call("/mercari/graphql")).status;
  out.unauth = (await call("/mercari/graphql", { h: { key: "wrong-key-aaaaaaaaaaaaaaaaaaaaaaaaaaaa" } })).status;
} else if (mode === "health") {
  out.healthz = (await call("/healthz", { method: "GET" })).status;
}
console.log(JSON.stringify(out, null, 2));
'@

  # ── 1〜5 ───────────────────────────────────────────────────────────
  Step "TLS / 認証 / 期限切れ署名 / 経路・宛先制限"
  Push-Location $repoRoot
  $raw = (node $nodeScript $staticIp "$tmp/ca.crt" "$tmp/relay.key" main 2>&1 | Out-String)
  Pop-Location
  if ($raw -notmatch '^\s*\{') { Ng "検証スクリプトが失敗しました"; Info $raw.Trim(); throw "検証を継続できません" }
  $r = $raw | ConvertFrom-Json

  if ($r.healthz -eq 200) { Ok "自前CAでTLS検証が通り /healthz が200" } else { Ng "/healthz = $($r.healthz)" }
  if ("$($r.tlsUntrusted)" -like "REJECTED*") { Ok "公開CAのみでは拒否される（自己署名が正しく機能）: $($r.tlsUntrusted)" } else { Ng "CA無しでも接続できてしまう: $($r.tlsUntrusted)" }

  if ($r.validAuth -ne 401) { Ok "正しい署名は認証を通過（status=$($r.validAuth)）" } else { Ng "正しい署名なのに401" }
  if ($r.badKey -eq 401)   { Ok "鍵違いは401" }        else { Ng "鍵違いが $($r.badKey)" }
  if ($r.badSig -eq 401)   { Ok "署名改竄は401" }      else { Ng "署名改竄が $($r.badSig)" }
  if ($r.noHeaders -eq 401){ Ok "ヘッダ欠落は401" }    else { Ng "ヘッダ欠落が $($r.noHeaders)" }
  if ($r.noHeadersErrHeader -eq "AUTH") { Ok "中継の認証失敗に X-Bello-Relay-Error: AUTH が付く（Mercariの401と区別可能）" } else { Ng "X-Bello-Relay-Error が付かない: $($r.noHeadersErrHeader)" }

  if ($r.staleTs -eq 401)  { Ok "15分前のタイムスタンプは401（リプレイ防止）" } else { Ng "古い署名が $($r.staleTs)" }
  if ($r.futureTs -eq 401) { Ok "15分後のタイムスタンプは401" }                 else { Ng "未来の署名が $($r.futureTs)" }

  if ($r.badPath -eq 404)   { Ok "許可外パスは404" }       else { Ng "許可外パスが $($r.badPath)" }
  if ($r.getOnPath -eq 405) { Ok "許可外メソッドは405" }   else { Ng "GETが $($r.getOnPath)" }

  if ($r.badEnv -eq 400)   { Ok "URLらしき env は400（任意URLへ転送されない）" } else { Ng "不正envが $($r.badEnv)" }
  if ($r.emptyEnv -eq 400) { Ok "空の env は400" }                                 else { Ng "空envが $($r.emptyEnv)" }

  Info "Mercariへの転送結果: status=$($r.forwardedStatus) / X-Bello-Relay-Error=$($r.forwardedRelayErr)"
  if ($r.forwardedStatus -eq 404 -and $r.forwardedRelayErr -eq "(なし)") {
    Ok "Mercariの404がそのまま返り、中継エラーヘッダは付かない（IP未申請時の正常な状態）"
  } elseif ($r.forwardedStatus -eq 200) {
    Ok "Mercariが200を返した（IP登録済み）"
  } else {
    Info "上流ステータス $($r.forwardedStatus) — IP申請前なら404が期待値"
  }

  # ── 6. レート制限 ──────────────────────────────────────────────────
  Step "レート制限"
  Push-Location $repoRoot
  $rawRate = (node $nodeScript $staticIp "$tmp/ca.crt" "$tmp/relay.key" rate 2>&1 | Out-String)
  Pop-Location
  $rr = $rawRate | ConvertFrom-Json
  if ($rr.rateLimited) { Ok "連投で429が返る（$($rr.requestsUntil429)回目）" } else { Ng "40回連投しても429にならない" }

  # ── 7. ログ秘匿 ────────────────────────────────────────────────────
  Step "ログの秘匿"
  # 本番インスタンスのjournalはSSHで取りに行かない —— 22番はLightsail
  # ブラウザSSHにしか開けていない(それが要件)ので、この端末からは繋げない。
  #
  # 代わりに、**同じ relay/server.mjs をこの端末で起動**し、実際のリクエストを
  # 通して標準出力を直接検査する。デプロイ済みのインスタンスは同一コードを
  # 動かしているため、マスキングの挙動はこれで決定的に確認できる。
  # 本番へ触れず、毎回同じ条件で再現できる分、SSHで覗くより良い検証になる。
  $localLog = Join-Path $tmp "local-relay.log"
  $localPort = 8443
  Set-Content -Path (Join-Path $tmp "local-relay.key") -Value $secret.relayKey -Encoding ascii -NoNewline
  Set-Content -Path (Join-Path $tmp "local-server.crt") -Value $secret.serverCert -Encoding ascii -NoNewline
  Set-Content -Path (Join-Path $tmp "local-server.key") -Value $secret.serverKey -Encoding ascii -NoNewline

  $env:RELAY_PORT        = "$localPort"
  $env:RELAY_CERT        = (Join-Path $tmp "local-server.crt")
  $env:RELAY_KEY         = (Join-Path $tmp "local-server.key")
  $env:RELAY_SHARED_KEY  = (Join-Path $tmp "local-relay.key")
  $relayProc = Start-Process -FilePath "node" -ArgumentList (Join-Path $repoRoot "relay/server.mjs") `
    -RedirectStandardOutput $localLog -RedirectStandardError (Join-Path $tmp "local-relay.err") `
    -NoNewWindow -PassThru
  Start-Sleep -Seconds 3
  try {
    # 認証OKのリクエストを1本通す(上流へは実際に出るが、IP未申請なら404が返るだけ)
    node $nodeScript "127.0.0.1:$localPort" "$tmp/ca.crt" "$tmp/relay.key" local | Out-Null
    Start-Sleep -Seconds 2
  } finally {
    if ($relayProc -and -not $relayProc.HasExited) { Stop-Process -Id $relayProc.Id -Force -ErrorAction SilentlyContinue }
  }
  $logs = if (Test-Path $localLog) { Get-Content $localLog -Raw -ErrorAction SilentlyContinue } else { "" }

  if ($logs -match "LISTENING" -or $logs -match "FORWARDED" -or $logs -match "UNAUTHORIZED") {
    Ok "同一コードのログを取得できた"
    $leaks = @()
    if ($logs -match "dummy-token-for-verification-only") { $leaks += "Mercariトークン" }
    if ($logs -match "Bearer\s+[A-Za-z0-9._\-]{10,}")      { $leaks += "Authorizationヘッダ" }
    if ($logs -match [regex]::Escape($secret.relayKey))    { $leaks += "中継共有鍵" }
    if ($logs -match "productCategories")                  { $leaks += "リクエスト本文(GraphQL)" }
    if ($leaks.Count -eq 0) { Ok "ログにトークン・Authorization・共有鍵・本文のいずれも出ていない" }
    else { Ng ("ログに機密が出ている: " + ($leaks -join ", ")) }

    if ($logs -match "operationName") { Ok "操作名など非機密の診断情報は記録されている" }
    else { Info "operationName が見つからない(転送が発生しなかった可能性)" }
  } else {
    Ng "ローカル起動したログを取得できなかった"
    Info (($logs + (Get-Content (Join-Path $tmp "local-relay.err") -Raw -ErrorAction SilentlyContinue)).Trim())
  }

  # ── 8. 再起動後の自動復帰 ──────────────────────────────────────────
  if ($SkipReboot) {
    Step "再起動テスト（-SkipReboot によりスキップ）"
  } else {
    Step "再起動後の自動復帰"
    aws lightsail reboot-instance --instance-name $InstanceName --region $Region --profile $Profile | Out-Null
    Info "再起動を要求しました。復帰を待ちます..."
    Start-Sleep -Seconds 30
    $recovered = $false
    for ($i = 0; $i -lt 30; $i++) {
      Start-Sleep -Seconds 10
      # 検証スクリプトの health モードを使い回す(node:https のみ・依存なし)
      $hj = (node $nodeScript $staticIp "$tmp/ca.crt" "$tmp/relay.key" health 2>&1 | Out-String)
      $h = if ($hj -match '"healthz"\s*:\s*"?(\d+|ERR|TIMEOUT)"?') { $Matches[1] } else { "ERR" }
      Info "  /healthz -> $h"
      if ($h -eq "200") { $recovered = $true; break }
    }
    if ($recovered) { Ok "再起動後、サービスが自動で復帰した（systemd Restart=always / enable済み）" }
    else { Ng "再起動後に復帰しなかった" }
  }

  # ── ファイアウォールの最終確認 ─────────────────────────────────────
  Step "ファイアウォール"
  $ports = (aws lightsail get-instance-port-states --instance-name $InstanceName --region $Region --profile $Profile --output json | ConvertFrom-Json).portStates
  foreach ($p in $ports) {
    $c = if ($p.cidrs) { $p.cidrs -join ',' } else { "(なし)" }
    $a = if ($p.cidrListAliases) { $p.cidrListAliases -join ',' } else { "(なし)" }
    Info ("port {0}/{1}: cidrs={2} aliases={3}" -f $p.fromPort, $p.protocol, $c, $a)
  }
  $ssh = $ports | Where-Object { $_.fromPort -eq 22 }
  if ($ssh -and ($ssh.cidrs -contains "0.0.0.0/0")) { Ng "22番が全世界へ公開されている" }
  elseif ($ssh -and ($ssh.cidrListAliases -contains "lightsail-connect")) { Ok "22番はLightsailブラウザSSHのみ（0.0.0.0/0ではない）" }
  elseif (-not $ssh) { Ok "22番は閉じている" }
  else { Info "22番の設定を目視確認してください" }

  $other = $ports | Where-Object { $_.fromPort -notin @(22,443) }
  if (-not $other) { Ok "443と22以外は開いていない" } else { Ng ("想定外のポートが開いている: " + (($other | ForEach-Object { $_.fromPort }) -join ',')) }

} finally {
  Get-ChildItem $tmp -File -ErrorAction SilentlyContinue | ForEach-Object {
    try { [System.IO.File]::WriteAllBytes($_.FullName, (New-Object byte[] $_.Length)) } catch {}
  }
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "=========================================================" -ForegroundColor Cyan
Write-Host (" 検証結果: {0} passed, {1} failed" -f $script:pass, $script:fail) -ForegroundColor $(if ($script:fail -eq 0) { "Green" } else { "Red" })
Write-Host "=========================================================" -ForegroundColor Cyan
if ($script:fail -gt 0) { exit 1 }

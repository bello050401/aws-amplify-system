#!/usr/bin/env node
/**
 * BELLO Mercari Shops API 中継サービス
 *
 * Mercari Shops APIは「日本国内の固定IPアドレス」からのリクエストしか
 * 受け付けない。BELLO本体(Amplify Hosting SSR / us-west-2)は固定の送信元IPを
 * 持てないため、Mercari呼び出しだけをこの東京のインスタンス経由にする。
 * 設計の全体像は docs/mercari-relay-design-20260901.md を参照。
 *
 * ## これは汎用プロキシではない
 *
 * - 受け付けるのは `POST /mercari/graphql` の1本だけ。
 * - 転送先URLはクライアントから受け取らない。`X-Bello-Mercari-Env` の
 *   production|sandbox という2値だけを見て、下の UPSTREAMS から選ぶ。
 * - それ以外のパス・メソッドはすべて拒否する。
 *
 * この2点を崩すと、インターネットに開いた自由に使えるプロキシになってしまう。
 *
 * ## 秘密情報の扱い
 *
 * - Mercariのアクセストークンは **保存しない**。BELLOがリクエストごとに
 *   Authorizationヘッダで渡し、ここはそれを転送するだけ。ディスクにも
 *   ログにも残さない。
 * - CA秘密鍵はこのサーバーに置かない(サーバー証明書と鍵のみ)。
 * - ログに出すのは操作名・ステータス・所要時間などの非機密情報だけ。
 *
 * 依存パッケージなし(Node標準ライブラリのみ)。npm installを不要にして、
 * 供給網リスクと運用の手間を最小化する。
 */
import { createServer } from "node:https";
import { readFileSync } from "node:fs";
import { createHmac, timingSafeEqual, X509Certificate } from "node:crypto";

// ── 設定 ────────────────────────────────────────────────────────────
const PORT = Number(process.env.RELAY_PORT ?? 443);
const CERT_PATH = process.env.RELAY_CERT ?? "/etc/bello-relay/server.crt";
const KEY_PATH = process.env.RELAY_KEY ?? "/etc/bello-relay/server.key";
const RELAY_KEY_PATH = process.env.RELAY_SHARED_KEY ?? "/etc/bello-relay/relay.key";

/** 転送先はここだけ。クライアントからURLを受け取らない。 */
const UPSTREAMS = Object.freeze({
  production: "https://api.mercari-shops.com/v1/graphql",
  sandbox: "https://api.mercari-shops-sandbox.com/v1/graphql",
});

const ALLOWED_PATH = "/mercari/graphql";
const MAX_BODY_BYTES = 256 * 1024;
const TIMESTAMP_SKEW_SEC = 300;
const UPSTREAM_TIMEOUT_MS = 15_000;
/** トークンバケット: 毎分60、バースト20。Mercari公式の上限(10,000ポイント/時)を十分下回る。 */
const RATE_PER_MIN = Number(process.env.RELAY_RATE_PER_MIN ?? 60);
const RATE_BURST = Number(process.env.RELAY_RATE_BURST ?? 20);
const MAX_CONCURRENT = Number(process.env.RELAY_MAX_CONCURRENT ?? 10);
/** 証明書の残り日数がこれを下回ったら警告を出す。 */
const CERT_WARN_DAYS = 60;

const relaySharedKey = readFileSync(RELAY_KEY_PATH, "utf8").trim();
if (!relaySharedKey) {
  console.error(JSON.stringify({ level: "fatal", msg: "relay shared key is empty" }));
  process.exit(1);
}

// ── ログ(機密は絶対に出さない) ──────────────────────────────────────
function log(level, fields) {
  process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), level, ...fields })}\n`);
}

/**
 * 上流のエラー本文をログ/応答へ載せる前の始末。
 * 長さを切り詰めたうえで、トークンらしき文字列をマスクする。
 */
function safeDetail(text) {
  if (!text) return "";
  return text
    .slice(0, 200)
    .replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, "Bearer ***")
    .replace(/"(token|accessToken|authorization)"\s*:\s*"[^"]*"/gi, '"$1":"***"');
}

/** GraphQLのオペレーション名だけを抜く(本文はログに出さないため、これが唯一の手掛かり)。 */
function operationNameOf(rawBody) {
  try {
    const q = JSON.parse(rawBody)?.query;
    if (typeof q !== "string") return "unknown";
    return /^\s*(?:query|mutation)\s+([A-Za-z0-9_]+)/.exec(q)?.[1] ?? "anonymous";
  } catch {
    return "unparsed";
  }
}

// ── 認証 ────────────────────────────────────────────────────────────
function constantTimeEqual(a, b) {
  const ba = Buffer.from(String(a ?? ""), "utf8");
  const bb = Buffer.from(String(b ?? ""), "utf8");
  // 長さが違うと timingSafeEqual は例外を投げる。長さ自体を秘匿する必要は
  // ないが、例外にせず false を返したいので先に揃えて比較する。
  if (ba.length !== bb.length) {
    // ダミー比較で処理時間を平坦化する。
    timingSafeEqual(ba, ba);
    return false;
  }
  return timingSafeEqual(ba, bb);
}

/**
 * 認証の判定。失敗理由は呼び出し元がログにだけ残し、応答では明かさない。
 *
 * 署名対象は `${timestamp}.${rawBody}` ——タイムスタンプを署名に含めることで、
 * 傍受したリクエストの使い回し(リプレイ)を防ぐ。
 */
function authenticate(req, rawBody) {
  const key = req.headers["x-bello-relay-key"];
  const ts = req.headers["x-bello-relay-timestamp"];
  const sig = req.headers["x-bello-relay-signature"];
  if (!key || !ts || !sig) return { ok: false, reason: "MISSING_HEADER" };
  if (!constantTimeEqual(key, relaySharedKey)) return { ok: false, reason: "BAD_KEY" };

  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum)) return { ok: false, reason: "BAD_TIMESTAMP" };
  const skew = Math.abs(Math.floor(Date.now() / 1000) - tsNum);
  if (skew > TIMESTAMP_SKEW_SEC) return { ok: false, reason: "TIMESTAMP_SKEW" };

  const expected = createHmac("sha256", relaySharedKey).update(`${tsNum}.${rawBody}`, "utf8").digest("base64");
  if (!constantTimeEqual(sig, expected)) return { ok: false, reason: "BAD_SIGNATURE" };
  return { ok: true };
}

// ── レート制限 ──────────────────────────────────────────────────────
let tokens = RATE_BURST;
let lastRefill = Date.now();
let inFlight = 0;

function takeToken() {
  const now = Date.now();
  tokens = Math.min(RATE_BURST, tokens + ((now - lastRefill) / 60_000) * RATE_PER_MIN);
  lastRefill = now;
  if (tokens < 1) return false;
  tokens -= 1;
  return true;
}

// ── 応答ヘルパ ──────────────────────────────────────────────────────
function send(res, status, body, headers = {}) {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...headers,
  });
  res.end(payload);
}

// ── リクエスト処理 ──────────────────────────────────────────────────
async function handle(req, res, requestId) {
  const started = Date.now();

  // ヘルスチェック: 認証不要だが、構成やバージョンは一切明かさない。
  if (req.method === "GET" && req.url === "/healthz") {
    return send(res, 200, { ok: true });
  }

  // 経路の制限。パスが違えば404、メソッドが違えば405。
  const path = (req.url ?? "").split("?")[0];
  if (path !== ALLOWED_PATH) {
    log("warn", { requestId, outcome: "NOT_FOUND", method: req.method, path });
    return send(res, 404, { error: "not_found" });
  }
  if (req.method !== "POST") {
    log("warn", { requestId, outcome: "METHOD_NOT_ALLOWED", method: req.method });
    return send(res, 405, { error: "method_not_allowed" }, { allow: "POST" });
  }

  // 本文の読み取り(上限つき)。
  let raw = "";
  let tooLarge = false;
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > MAX_BODY_BYTES) { tooLarge = true; break; }
  }
  if (tooLarge) {
    log("warn", { requestId, outcome: "PAYLOAD_TOO_LARGE" });
    return send(res, 413, { error: "payload_too_large" });
  }

  // 認証。**失敗時は X-Bello-Relay-Error: AUTH を必ず付ける** ——
  // これが無いと、BELLO側で「中継の鍵違い」と「Mercariのトークン不正」が
  // どちらも401として同じ AUTH_FAILED に落ち、正しいトークンが
  // 「不正」と判定されて保存されなくなる(connectionPolicyのTOKEN_REJECTED)。
  const auth = authenticate(req, raw);
  if (!auth.ok) {
    log("warn", { requestId, outcome: "UNAUTHORIZED", reason: auth.reason });
    return send(res, 401, { error: "unauthorized" }, { "x-bello-relay-error": "AUTH" });
  }

  // 転送先の決定。クライアントはURLを指定できない。
  const env = String(req.headers["x-bello-mercari-env"] ?? "").toLowerCase();
  const upstream = UPSTREAMS[env];
  if (!upstream) {
    log("warn", { requestId, outcome: "BAD_ENV", env: env.slice(0, 20) });
    return send(res, 400, { error: "bad_environment" }, { "x-bello-relay-error": "ENV" });
  }

  // レート制限。上流には投げない(Mercari側の制限を守るため)。
  if (inFlight >= MAX_CONCURRENT) {
    log("warn", { requestId, outcome: "TOO_MANY_CONCURRENT", inFlight });
    return send(res, 429, { error: "too_many_requests" }, { "retry-after": "5", "x-bello-relay-error": "RATE" });
  }
  if (!takeToken()) {
    log("warn", { requestId, outcome: "RATE_LIMITED" });
    return send(res, 429, { error: "rate_limited" }, { "retry-after": "10", "x-bello-relay-error": "RATE" });
  }

  const operationName = operationNameOf(raw);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  inFlight++;

  try {
    // 転送するヘッダは必要な3つだけ。Cookie等は一切引き継がない。
    const upstreamRes = await fetch(upstream, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // Authorization と User-Agent はBELLOから受け取った値をそのまま渡す。
        // 保存もログ出力もしない。
        ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}),
        ...(req.headers["x-bello-mercari-user-agent"] ? { "user-agent": String(req.headers["x-bello-mercari-user-agent"]) } : {}),
      },
      body: raw,
      signal: controller.signal,
    });

    const text = await upstreamRes.text();
    log("info", {
      requestId,
      outcome: "FORWARDED",
      env,
      operationName,
      upstreamStatus: upstreamRes.status,
      durationMs: Date.now() - started,
      requestBytes: Buffer.byteLength(raw),
      responseBytes: Buffer.byteLength(text),
      // 上流が非2xxのときだけ、マスク済みの短い抜粋を残す。
      ...(upstreamRes.ok ? {} : { detail: safeDetail(text) }),
    });

    // 上流のステータスと本文をそのまま返す。BELLO側の既存のエラー分類が
    // そのまま働くようにするため、ここで解釈や変換はしない。
    res.writeHead(upstreamRes.status, {
      "content-type": upstreamRes.headers.get("content-type") ?? "application/json",
      "cache-control": "no-store",
      ...(upstreamRes.headers.get("x-ratelimit-reset") ? { "x-ratelimit-reset": upstreamRes.headers.get("x-ratelimit-reset") } : {}),
    });
    res.end(text);
  } catch (err) {
    const timedOut = controller.signal.aborted || err?.name === "AbortError";
    log("error", {
      requestId,
      outcome: timedOut ? "UPSTREAM_TIMEOUT" : "UPSTREAM_ERROR",
      env,
      operationName,
      durationMs: Date.now() - started,
      errorName: err?.name ?? "unknown",
    });
    // 504/502は、BELLO側で TIMEOUT / NETWORK_ERROR へ分類される。
    // どちらも「トークンの正否は判定できない」扱いなので、既存の
    // 検証済み設定が壊れることはない。
    send(res, timedOut ? 504 : 502, { error: timedOut ? "upstream_timeout" : "upstream_error" }, { "x-bello-relay-error": "UPSTREAM" });
  } finally {
    clearTimeout(timer);
    inFlight--;
  }
}

// ── 証明書の有効期限監視 ────────────────────────────────────────────
function checkCertExpiry(certPem) {
  try {
    const cert = new X509Certificate(certPem);
    const daysLeft = Math.floor((new Date(cert.validTo).getTime() - Date.now()) / 86_400_000);
    log(daysLeft <= CERT_WARN_DAYS ? "warn" : "info", {
      outcome: "CERT_EXPIRY_CHECK",
      validTo: cert.validTo,
      daysLeft,
      ...(daysLeft <= CERT_WARN_DAYS ? { action: "証明書の更新が必要です" } : {}),
    });
  } catch (err) {
    log("error", { outcome: "CERT_EXPIRY_CHECK_FAILED", errorName: err?.name ?? "unknown" });
  }
}

// systemd への ready 通知(sd_notify)は行わない。
// Node は AF_UNIX の**データグラム**ソケットを作れず
// (dgram.createSocket は udp4/udp6 のみ)、NOTIFY_SOCKET へ通知する手段が
// 標準ライブラリだけでは無い。Type=notify のまま READY=1 を送らないと
// systemd は起動失敗とみなして再起動を繰り返す(実際にそうなった)。
// そのため unit 側は Type=exec とし、プロセスの生存監視は
// Restart=always と /healthz に任せる。

// ── 起動 ────────────────────────────────────────────────────────────
const certPem = readFileSync(CERT_PATH, "utf8");
const server = createServer(
  { cert: certPem, key: readFileSync(KEY_PATH, "utf8"), minVersion: "TLSv1.2" },
  (req, res) => {
    const requestId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    handle(req, res, requestId).catch((err) => {
      log("error", { requestId, outcome: "UNHANDLED", errorName: err?.name ?? "unknown" });
      if (!res.headersSent) send(res, 500, { error: "internal_error" });
    });
  },
);

server.headersTimeout = 20_000;
server.requestTimeout = 30_000;
server.keepAliveTimeout = 30_000;

server.listen(PORT, () => {
  log("info", { outcome: "LISTENING", port: PORT, upstreams: Object.keys(UPSTREAMS) });
  checkCertExpiry(certPem);
  // 1日1回、証明書の残り日数を点検する。
  setInterval(() => checkCertExpiry(certPem), 86_400_000).unref();
});

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    log("info", { outcome: "SHUTDOWN", signal: sig });
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10_000).unref();
  });
}

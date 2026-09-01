import "server-only";
import { request as httpsRequest } from "node:https";
import { createHmac } from "node:crypto";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import type { MercariEnvironment } from "./endpoints";

/**
 * Mercari中継サーバー(東京 / Lightsail)経由でMercari Shops APIを呼ぶための層。
 *
 * ## なぜ中継が要るのか
 *
 * Mercariは「日本国内の固定IPアドレス」からのリクエストしか受け付けない。
 * BELLO本体はAmplify HostingのSSRコンピュート上で動き、**顧客VPCへ接続
 * できない**(`aws amplify update-app/update-branch` にVPC系パラメータが
 * 存在しないことを実測)ため、NAT Gateway + Elastic IP を作っても送信元IPを
 * 固定できない。そこでMercari呼び出しだけを東京の小さな常時稼働
 * インスタンスへ通す。設計: docs/mercari-relay-design-20260901.md
 *
 * ## 未設定なら何も変わらない
 *
 * `MERCARI_RELAY_URL` が無ければこのモジュールは何もせず、
 * lib/listing/mercari/client.ts は従来どおりMercariへ直接接続する。
 * 既存の動作を変えないための境界。
 *
 * ## TLS
 *
 * 中継は独自ドメインを持たないため、固定IPをSANに持つ**自前CA発行の証明書**を
 * 使う。ここでは公開CAではなく**そのCAだけ**を信頼する(`ca` を明示)。
 * 公開PKIに依存しないぶん、経路を限定するという意味ではむしろ強い。
 *
 * Nodeのグローバル`fetch`にはCAを差し込む口が無い(undiciのAgentが必要で、
 * このリポジトリはundiciを依存に持たない)ため、`node:https` を直接使い、
 * 呼び出し側が扱いやすいよう標準の `Response` を組み立てて返す。
 */

/** Secrets Managerの`bello/mercari-relay`が持つ値のうち、BELLOが使うもの。 */
interface RelayMaterial {
  relayKey: string;
  caCert: string;
}

const SECRET_NAME = "bello/mercari-relay";
const REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-west-2";
/** BELLO→中継のタイムアウト。中継→Mercariの15秒より長くして、どちらで切れたかを区別できるようにする。 */
const RELAY_TIMEOUT_MS = 20_000;
/** 秘密の取得はリクエストごとに行わない。プロセス内で使い回す。 */
const MATERIAL_TTL_MS = 10 * 60 * 1000;

let cached: { at: number; material: RelayMaterial } | null = null;
let smClient: SecretsManagerClient | null = null;

/** 中継が設定されているか。未設定なら直接接続へ倒す。 */
export function getMercariRelayUrl(): string | null {
  const raw = process.env.MERCARI_RELAY_URL?.trim();
  if (!raw) return null;
  return raw.replace(/\/+$/, "");
}

async function loadMaterial(): Promise<RelayMaterial> {
  if (cached && Date.now() - cached.at < MATERIAL_TTL_MS) return cached.material;
  if (!smClient) smClient = new SecretsManagerClient({ region: REGION });
  const res = await smClient.send(new GetSecretValueCommand({ SecretId: SECRET_NAME }));
  const parsed = JSON.parse(res.SecretString ?? "{}") as Partial<RelayMaterial>;
  if (!parsed.relayKey || !parsed.caCert) {
    throw new Error("中継の共有鍵またはCA証明書を取得できませんでした。");
  }
  const material = { relayKey: parsed.relayKey, caCert: parsed.caCert };
  cached = { at: Date.now(), material };
  return material;
}

/**
 * 中継の認証ヘッダを組み立てる。
 *
 * 署名対象は `${timestamp}.${body}` —— タイムスタンプを署名へ含めることで、
 * 傍受したリクエストの使い回し(リプレイ)を防ぐ。中継側は±300秒だけ許容する。
 * exportしているのはテスト(scripts/verify-mercari.ts)が署名の作り方を
 * 固定できるようにするため。
 */
export function buildRelayAuthHeaders(relayKey: string, body: string, nowSec = Math.floor(Date.now() / 1000)): Record<string, string> {
  return {
    "x-bello-relay-key": relayKey,
    "x-bello-relay-timestamp": String(nowSec),
    "x-bello-relay-signature": createHmac("sha256", relayKey).update(`${nowSec}.${body}`, "utf8").digest("base64"),
  };
}

/**
 * 中継経由でMercariへPOSTする。戻り値は標準の `Response` なので、
 * 呼び出し側(client.ts)は直接接続の場合とまったく同じ扱いができる。
 *
 * 中継自身の認証失敗は `X-Bello-Relay-Error: AUTH` が付いて返る。
 * client.ts はこれを見て `AUTH_FAILED` ではなく `NETWORK_ERROR` へ分類する
 * —— そうしないと「中継の鍵が違う」だけで、正しいMercariトークンが
 * 「不正」と判定されて保存されなくなる(connectionPolicy の TOKEN_REJECTED)。
 */
export async function postViaMercariRelay(params: {
  relayUrl: string;
  environment: MercariEnvironment;
  body: string;
  token: string;
  userAgent: string;
  signal?: AbortSignal;
}): Promise<Response> {
  const { relayKey, caCert } = await loadMaterial();
  const url = new URL(`${params.relayUrl}/mercari/graphql`);

  const headers: Record<string, string> = {
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(params.body)),
    // Mercariのトークンは中継に保存されない。都度渡して素通しさせる。
    authorization: `Bearer ${params.token}`,
    // 中継はUser-Agentを転送するだけ。Mercari公式の必須要件を満たすため。
    "x-bello-mercari-user-agent": params.userAgent,
    // 転送先はこの2値のいずれかだけ。URLは渡さない(汎用プロキシにしない)。
    "x-bello-mercari-env": params.environment,
    ...buildRelayAuthHeaders(relayKey, params.body),
  };

  return new Promise<Response>((resolve, reject) => {
    const req = httpsRequest(
      {
        host: url.hostname,
        port: url.port ? Number(url.port) : 443,
        path: url.pathname,
        method: "POST",
        headers,
        // 公開CAではなく、この中継のためのCAだけを信頼する。
        ca: caCert,
        timeout: RELAY_TIMEOUT_MS,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const responseHeaders = new Headers();
          for (const [k, v] of Object.entries(res.headers)) {
            if (typeof v === "string") responseHeaders.set(k, v);
            else if (Array.isArray(v)) responseHeaders.set(k, v.join(", "));
          }
          resolve(new Response(Buffer.concat(chunks), { status: res.statusCode ?? 502, headers: responseHeaders }));
        });
      },
    );

    req.on("timeout", () => {
      req.destroy();
      const err = new Error(`Relay timed out after ${RELAY_TIMEOUT_MS}ms`);
      err.name = "AbortError";
      reject(err);
    });
    req.on("error", (e) => reject(e));

    if (params.signal) {
      if (params.signal.aborted) req.destroy();
      else params.signal.addEventListener("abort", () => req.destroy(), { once: true });
    }

    req.write(params.body);
    req.end();
  });
}

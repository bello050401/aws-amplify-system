import "server-only";
import { SecretsManagerClient, GetSecretValueCommand, PutSecretValueCommand, ResourceNotFoundException } from "@aws-sdk/client-secrets-manager";

/**
 * BASE APIのアプリ認証情報（Client ID / Client Secret）の保存先。
 *
 * 【なぜ環境変数ではなくSecrets Managerか】これまで
 * `BASE_CLIENT_ID` / `BASE_CLIENT_SECRET` は環境変数だったため、設定するのに
 * AWSコンソールとデプロイが要り、管理画面からは「未設定です」と表示する
 * ことしかできなかった。同じ問題をZAICO・Mercari・LINEでは既に
 * Secrets Manager + ADMIN限定のServer Actionで解いてあるので、同じ形にする
 * （lib/listing/mercari/secretStore.ts と同じ構造・同じ安全策）。
 *
 * 【ブラウザはAWSに触らない】保存はServer Action経由で、実際に
 * Secrets Managerを書くのはSSRの実行ロール。ブラウザへAWSの権限は一切
 * 渡らないし、`NEXT_PUBLIC_` にも置かない。
 *
 * 【権限は1本だけ】Secret自体はAWS側で先に作成済みで、実行ロールには
 * この1本への GetSecretValue / PutSecretValue だけを与えてある。
 * CreateSecret は与えていない —— 管理画面の操作で新しいSecretを
 * 作れてしまう必要がない。
 *
 * 【値は絶対にログへ出さない】このファイルは clientSecret を返す関数と
 * 「設定済みか」を返す関数を分けてある。画面や監査へ出るのは後者だけ。
 */

const SECRET_NAME = "bello/base-app-credentials";
/** lib/zaico/secretStore.ts と同じ理由（BELLOの実デプロイ先）。 */
const REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-west-2";

interface BaseCredentialsPayload {
  configured: boolean;
  clientId?: string;
  clientSecret?: string;
  /**
   * BASE Developers側でこのアプリに許可されている権限に合わせた要求スコープ。
   *
   * 【なぜ設定できる必要があるか】BELLOのBASE出品機能(items/add・items/edit)は
   * `write_items` を要る。しかし実際に登録されているBASEアプリの利用権限が
   * 「ショップ情報を見る」「商品情報を見る」だけの場合、`write_items` を
   * 要求すると認可自体が通らない —— **読み取りすらできなくなる**。
   * 権限の追加はBASE側の操作なので、こちら側で待たずに済むよう、
   * 要求スコープを設定として持つ。
   */
  requestWriteItems?: boolean;
  /** 誰がいつ設定したか（監査用。値そのものは含まない）。 */
  updatedAt?: string;
  updatedBy?: string;
}

/** 削除時に書き戻す中身。Secret自体は消さない（権限を最小にしてあるため）。 */
const UNCONFIGURED_PAYLOAD: BaseCredentialsPayload = { configured: false };

let client: SecretsManagerClient | null = null;
function getClient(): SecretsManagerClient {
  if (!client) client = new SecretsManagerClient({ region: REGION });
  return client;
}

/** リクエストごとにSecrets Managerを叩かない。値は短時間だけプロセス内に置く。 */
const CACHE_TTL_MS = 5 * 60 * 1000;
let cache: { at: number; payload: BaseCredentialsPayload } | null = null;

export function clearBaseCredentialsCache(): void {
  cache = null;
}

async function readPayload(): Promise<BaseCredentialsPayload> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.payload;
  try {
    const res = await getClient().send(new GetSecretValueCommand({ SecretId: SECRET_NAME }));
    const parsed = JSON.parse(res.SecretString ?? "{}") as BaseCredentialsPayload;
    const payload = parsed.configured && parsed.clientId && parsed.clientSecret ? parsed : UNCONFIGURED_PAYLOAD;
    cache = { at: Date.now(), payload };
    return payload;
  } catch (err) {
    // 「未設定」と「読めなかった」は違う。前者は想定内、後者は権限や
    // ネットワークの問題なので警告として残す（値は出さない）。
    if (!(err instanceof ResourceNotFoundException)) {
      console.warn("[base/secretStore] Secretを読めませんでした", {
        name: SECRET_NAME,
        error: err instanceof Error ? err.name : "unknown",
      });
    }
    return UNCONFIGURED_PAYLOAD;
  }
}

export type BaseCredentialsSource = "secrets-manager" | "env-fallback" | "unconfigured";

export interface BaseCredentials {
  clientId: string;
  clientSecret: string;
  /** 認可時に要求するスコープに `write_items` を含めるか。 */
  requestWriteItems: boolean;
  source: Exclude<BaseCredentialsSource, "unconfigured">;
}

/**
 * 認証情報そのもの。**呼び出してよいのはOAuthのトークン交換だけ。**
 *
 * 環境変数へのフォールバックを残しているのは、既にAWSコンソール側で
 * 設定して動かしている環境（ローカル開発を含む）を壊さないため。
 * Secrets Manager側が設定済みならそちらが優先される。
 */
export async function getBaseCredentials(): Promise<BaseCredentials | null> {
  const payload = await readPayload();
  if (payload.configured && payload.clientId && payload.clientSecret) {
    return {
      clientId: payload.clientId,
      clientSecret: payload.clientSecret,
      // 既存の保存値に項目が無い場合は、これまでの既定（read+write）を維持する。
      requestWriteItems: payload.requestWriteItems ?? true,
      source: "secrets-manager",
    };
  }
  const envId = process.env.BASE_CLIENT_ID?.trim();
  const envSecret = process.env.BASE_CLIENT_SECRET?.trim();
  if (envId && envSecret) {
    return { clientId: envId, clientSecret: envSecret, requestWriteItems: true, source: "env-fallback" };
  }
  return null;
}

export interface BaseCredentialsState {
  source: BaseCredentialsSource;
  /** Client IDは秘密値ではないので画面に出してよい（Secretは出さない）。 */
  clientId: string | null;
  requestWriteItems: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
}

/** 画面表示用。**Client Secretは絶対に返さない。** */
export async function getBaseCredentialsState(): Promise<BaseCredentialsState> {
  const payload = await readPayload();
  if (payload.configured && payload.clientId && payload.clientSecret) {
    return {
      source: "secrets-manager",
      clientId: payload.clientId,
      requestWriteItems: payload.requestWriteItems ?? true,
      updatedAt: payload.updatedAt ?? null,
      updatedBy: payload.updatedBy ?? null,
    };
  }
  const envId = process.env.BASE_CLIENT_ID?.trim();
  const envSecret = process.env.BASE_CLIENT_SECRET?.trim();
  if (envId && envSecret) {
    return { source: "env-fallback", clientId: envId, requestWriteItems: true, updatedAt: null, updatedBy: null };
  }
  return { source: "unconfigured", clientId: null, requestWriteItems: true, updatedAt: null, updatedBy: null };
}

/**
 * 保存。値の検証はここでは形だけ（空でない・空白が混ざっていない）。
 * 本当に正しいかはOAuthを通してみないと分からないので、
 * 「保存できた」を「接続できた」と混同させないよう、状態は別に持つ。
 */
export async function saveBaseCredentials(input: {
  clientId: string;
  clientSecret: string;
  requestWriteItems: boolean;
  who: string | null;
}): Promise<void> {
  const clientId = input.clientId.trim();
  const clientSecret = input.clientSecret.trim();
  if (!clientId || !clientSecret) throw new Error("Client IDとClient Secretの両方を入力してください。");
  // 貼り付け時に混ざりやすいものを弾く。ここで弾かないと、OAuthが
  // 「invalid_client」で失敗したときに原因が分かりにくくなる。
  if (/\s/.test(clientId) || /\s/.test(clientSecret)) {
    throw new Error("Client ID / Client Secret に空白が含まれています。前後の空白や改行を取り除いてください。");
  }

  const payload: BaseCredentialsPayload = {
    configured: true,
    clientId,
    clientSecret,
    requestWriteItems: input.requestWriteItems,
    updatedAt: new Date().toISOString(),
    updatedBy: input.who ?? undefined,
  };
  await getClient().send(new PutSecretValueCommand({ SecretId: SECRET_NAME, SecretString: JSON.stringify(payload) }));
  clearBaseCredentialsCache();
}

/** 削除。Secretの実体は消さず、未設定の中身へ書き戻す（権限を最小にしてあるため）。 */
export async function deleteBaseCredentials(): Promise<void> {
  await getClient().send(new PutSecretValueCommand({ SecretId: SECRET_NAME, SecretString: JSON.stringify(UNCONFIGURED_PAYLOAD) }));
  clearBaseCredentialsCache();
}

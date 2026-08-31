import "server-only";
import { getMercariConnectionFromSecretsManager, getMercariTokenFromSecretsManager, readMercariConnectionSecret } from "./secretStore";
import { formatMercariUserAgent, MERCARI_DEFAULT_CLIENT_VERSION } from "./endpoints";

/**
 * BELLO統合改修 master指示書 Phase D — lib/zaico/client.tsの
 * getZaicoApiToken/isZaicoConnected/getZaicoTokenSourceと同一の設計
 * (AWS Secrets Manager優先、無ければサーバー環境変数
 * MERCARI_ACCESS_TOKENへフォールバック)をMercari用に用意したもの。
 * 値はこのファイルの戻り値としてのみ存在し、呼び出し元
 * (lib/listing/mercari/client.tsのMercariShopsClient)がAuthorization
 * ヘッダへ直接渡す以外の用途では使わない。
 */
export async function getMercariAccessToken(): Promise<string> {
  const fromSecretsManager = await getMercariTokenFromSecretsManager();
  const token = fromSecretsManager ?? process.env.MERCARI_ACCESS_TOKEN;
  if (!token) {
    throw new Error(
      "Mercari Shops Personal API Access Tokenが設定されていません。設定画面のEC出品タブから登録するか、サーバー環境変数MERCARI_ACCESS_TOKENを設定してください（値そのものはログに出力されません）。",
    );
  }
  return token;
}

export async function isMercariConnected(): Promise<boolean> {
  if (await getMercariTokenFromSecretsManager()) return true;
  return Boolean(process.env.MERCARI_ACCESS_TOKEN);
}

export type MercariTokenSource = "secrets-manager" | "env-fallback" | "unconfigured";

export async function getMercariTokenSource(): Promise<MercariTokenSource> {
  if (await getMercariTokenFromSecretsManager()) return "secrets-manager";
  if (process.env.MERCARI_ACCESS_TOKEN) return "env-fallback";
  return "unconfigured";
}

/**
 * BELLO統合業務OS指示書(2026-08-30) §24/§26: 「APIクライアント名も
 * server-side config、環境変数フォールバック可」— TOKENと全く同じ
 * secrets-manager優先・env-fallbackの経路。§92「新token検証失敗時に
 * 既存の有効設定を破壊しない」もTOKENと同じくsecretへの書き込みが
 * 検証成功後にしか行われない(app/actions/mercariSecret.ts参照)ことで
 * 満たされる。
 *
 * 1回のGetSecretValueでtoken/clientName/clientVersionをまとめて読む
 * getMercariConnectionFromSecretsManagerを使う — getMercariAccessToken
 * (token単体)と合わせて呼ぶと2回GetSecretValueが飛ぶ非効率が生じるが、
 * 呼び出し頻度(出品操作の都度)を考えると許容範囲と判断した
 * (§126のrate limit配慮は主に外部Mercari API自体に対するものであり、
 * 自社のSecrets Manager呼び出し回数はそれとは別の話)。
 */
export async function getMercariClientNameConfig(): Promise<{ clientName: string | null; clientVersion: string; source: MercariTokenSource }> {
  const fromSecretsManager = await getMercariConnectionFromSecretsManager();
  if (fromSecretsManager.clientName) {
    return { clientName: fromSecretsManager.clientName, clientVersion: fromSecretsManager.clientVersion ?? MERCARI_DEFAULT_CLIENT_VERSION, source: "secrets-manager" };
  }
  const envName = process.env.MERCARI_API_CLIENT_NAME?.trim();
  if (envName) {
    return { clientName: envName, clientVersion: process.env.MERCARI_API_CLIENT_VERSION?.trim() || MERCARI_DEFAULT_CLIENT_VERSION, source: "env-fallback" };
  }
  return { clientName: null, clientVersion: MERCARI_DEFAULT_CLIENT_VERSION, source: "unconfigured" };
}

export async function isMercariApiClientNameConfigured(): Promise<boolean> {
  return (await getMercariClientNameConfig()).clientName !== null;
}

/**
 * lib/listing/mercari/client.tsが実際のリクエストごとに呼ぶ、User-Agent
 * ヘッダの最終的な値。endpoints.tsのgetMercariUserAgent根本原因調査
 * コメント参照 — 未設定の場合はCONFIG_REQUIREDとして明確なエラーを
 * 投げ、決して仮の値を送らない。
 */
export async function getMercariUserAgent(): Promise<string> {
  const { clientName, clientVersion } = await getMercariClientNameConfig();
  if (!clientName) {
    throw new Error(
      "MERCARI_API_CLIENT_NAMEが設定されていません。設定画面のEC出品タブから登録するか、サーバー環境変数MERCARI_API_CLIENT_NAMEを設定してください（Mercari公式ドキュメントによれば、正しいUser-Agentヘッダを送らないリクエストは拒否されます。値の割り当てについてはMercari Shopsの契約担当窓口へご確認ください）。",
    );
  }
  return formatMercariUserAgent(clientName, clientVersion);
}

/**
 * 夜間統合指示書(2026-09-01) §3.4/§6.7: 「接続済み / 未設定 / 設定済み
 * 未検証 / 読み取り失敗」を混同せずに1回のGetSecretValueで解決する、
 * 設定画面向けの単一の状態取得関数。
 *
 * これまで設定ページ(app/inventory/(protected)/settings/page.tsx)は
 * getMercariTokenSource()とgetMercariClientNameConfig()を両方awaitして
 * おり、同じSecretに対してGetSecretValueが2回飛んでいた(それぞれが
 * 内部で独立に読むため)。TOKEN・クライアント名・検証状態はすべて同じ
 * payloadに同居しているので、ここで1回だけ読んでまとめて返す。
 */
export type MercariVerificationState = "verified" | "unverified" | "unknown";

export interface MercariConnectionState {
  tokenSource: MercariTokenSource;
  clientName: string | null;
  clientNameSource: MercariTokenSource;
  clientVersion: string;
  /**
   * verified   : Secretに保存済みで、保存時に実際の接続確認が取れていた
   * unverified : Secretに保存済みだが接続確認が取れていない(IP未登録等)
   * unknown    : 環境変数フォールバック由来、または未設定 — 検証記録が存在しない
   */
  verification: MercariVerificationState;
  lastCheckedAt: string | null;
  lastCheckCode: string | null;
  /**
   * Secretを読めなかった場合の利用者向け説明(権限不足・認証切れ等)。
   * null以外なら、画面は「未設定」ではなく「設定を確認できません」と
   * 表示しなければならない — §6.1で問題にした「失敗を未設定として
   * 黙って表示する」を防ぐための情報。
   */
  secretReadError: string | null;
}

export async function getMercariConnectionState(): Promise<MercariConnectionState> {
  const read = await readMercariConnectionSecret();

  const envToken = process.env.MERCARI_ACCESS_TOKEN?.trim();
  const envName = process.env.MERCARI_API_CLIENT_NAME?.trim();
  const envVersion = process.env.MERCARI_API_CLIENT_VERSION?.trim() || MERCARI_DEFAULT_CLIENT_VERSION;

  if (!read.ok) {
    // Secretが読めない場合でも環境変数フォールバックがあれば動作自体は
    // 可能なので、そちらの状態は正直に返しつつ、読めなかった事実も返す。
    return {
      tokenSource: envToken ? "env-fallback" : "unconfigured",
      clientName: envName ?? null,
      clientNameSource: envName ? "env-fallback" : "unconfigured",
      clientVersion: envVersion,
      verification: "unknown",
      lastCheckedAt: null,
      lastCheckCode: null,
      secretReadError: read.errorMessage,
    };
  }

  const tokenSource: MercariTokenSource = read.token ? "secrets-manager" : envToken ? "env-fallback" : "unconfigured";
  const clientName = read.clientName ?? envName ?? null;
  const clientNameSource: MercariTokenSource = read.clientName ? "secrets-manager" : envName ? "env-fallback" : "unconfigured";

  return {
    tokenSource,
    clientName,
    clientNameSource,
    clientVersion: read.clientVersion ?? (clientNameSource === "env-fallback" ? envVersion : MERCARI_DEFAULT_CLIENT_VERSION),
    // 検証記録はSecrets Manager経由の設定にしか存在しない。
    verification: tokenSource === "secrets-manager" ? (read.verified ? "verified" : "unverified") : "unknown",
    lastCheckedAt: read.lastCheckedAt,
    lastCheckCode: read.lastCheckCode,
    secretReadError: null,
  };
}

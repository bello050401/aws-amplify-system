import { adminAuthMode, serverDataClient } from "@/lib/amplify/dataClient";
import { getBaseCredentials } from "./secretStore";
import { BaseNotConfiguredError } from "./errors";
import { resolveRedirectUri } from "./redirectUri";
import { resolveScope } from "./scope";

/**
 * BASE OAuth2 — authorization-code flow + refresh, with the token
 * persisted in Amplify Data (`BaseOAuthToken`, Admins-only) instead of a
 * static env var, because a refresh can rotate the refresh_token itself;
 * a value baked into `.env` at deploy time would silently go stale the
 * first time that happens. See docs/NOTES_BASE_API.md for confidence
 * level on the exact endpoint paths below.
 */
const AUTHORIZE_ENDPOINT = "https://api.thebase.in/1/oauth/authorize";
const TOKEN_ENDPOINT = "https://api.thebase.in/1/oauth/token";
const TOKEN_ROW_ID = "singleton";
/**
 * BELLOベンダー非依存・交換可能アーキテクチャ仕様書(2026-08-30) §18
 * 監査で発見: lib/listing/base/adapter.ts(第二次ラウンドで新設、
 * items/add・items/edit経由でBASEへ実際に出品・価格変更する)が要求
 * するBASE公式スコープ`write_items`(WebSearchで確認: read_users/
 * read_users_mail/read_items/read_orders/read_savings/write_items/
 * write_ordersがBASE公式の全スコープ)が、以前からのFeature-page
 * 読み取り専用スコープ("read_items"のみ)に含まれていなかった —
 * このままでは新しく接続したBASE OAuthトークンにEC出品用の書き込み
 * 権限が付与されず、items/add/items/edit呼び出しがすべて権限エラーに
 * なる。read_items(既存のFeature-page機能が使用)とwrite_items
 * (新設のBASE Listing Channel Adapterが使用)を両方要求するよう修正。
 */
/** 要求スコープの決定は lib/base/scope.ts（純粋関数、単体検証対象）。 */

/**
 * Client ID / Secret は環境変数ではなく lib/base/secretStore.ts が持つ
 * （Secrets Manager優先・環境変数フォールバック）。以前は
 * `requireEnv("BASE_CLIENT_ID")` を直接読んでいたため、設定画面から
 * 接続を完了する手段が無く、AWSコンソール＋再デプロイが必須だった。
 */
async function requireCredentials(): Promise<{ clientId: string; clientSecret: string; requestWriteItems: boolean }> {
  const creds = await getBaseCredentials();
  if (!creds) throw new BaseNotConfiguredError();
  return { clientId: creds.clientId, clientSecret: creds.clientSecret, requestWriteItems: creds.requestWriteItems };
}

/**
 * Builds the URL to send the signed-in admin's browser to, to start the
 * consent flow. `redirect_uri` はリクエストから組み立てる —— 認可時と
 * トークン交換時で同じ値になることが正しさの条件なので、
 * lib/base/redirectUri.ts の1か所で決める。
 */
export async function buildAuthorizeUrl(state: string, request: Request): Promise<string> {
  const { clientId, requestWriteItems } = await requireCredentials();
  const url = new URL(AUTHORIZE_ENDPOINT);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", resolveRedirectUri(request));
  url.searchParams.set("scope", resolveScope(requestWriteItems));
  url.searchParams.set("state", state);
  return url.toString();
}

interface RawTokenResponse {
  access_token: string;
  refresh_token?: string; // some providers omit this on refresh to mean "unchanged"
  expires_in: number; // seconds
}

/**
 * トークン交換の失敗。**BASEの応答本文をそのまま利用者へ出さない**ため、
 * 機械可読なコードと日本語の説明に畳んでから投げる。
 * リクエスト本文にはclient_secretが入っているので、失敗時に
 * 「送ったもの」をログへ出すことは決してしない。
 */
export class BaseTokenExchangeError extends Error {
  constructor(
    message: string,
    /** BASEが返した `error` フィールド（invalid_client / invalid_grant 等）。 */
    public readonly code: string | null,
    public readonly status: number | null,
  ) {
    super(message);
    this.name = "BaseTokenExchangeError";
  }
}

/** BASEのエラーコードを、担当者が次に何をすればよいか分かる日本語にする。 */
function describeTokenError(code: string | null, status: number | null): string {
  switch (code) {
    case "invalid_client":
      return "BASEがClient ID / Client Secretを受け付けませんでした。設定画面で登録した値がBASE Developersのものと一致しているか確認してください。";
    case "invalid_grant":
      return "認可コードが無効か、既に使用済みです。設定画面からもう一度「BASEアカウントを連携する」をやり直してください。";
    case "redirect_uri_mismatch":
      return "コールバックURLがBASE Developersへ登録した値と一致していません。設定画面に表示されているコールバックURLをそのまま登録してください。";
    case "invalid_scope":
      return "要求した権限（スコープ）がBASEアプリに許可されていません。BASE Developers側でread_items / write_itemsを有効にしてください。";
    default:
      return `BASEとのトークン交換に失敗しました（${code ?? `HTTP ${status ?? "不明"}`}）。時間をおいて再度お試しください。`;
  }
}

async function requestToken(params: Record<string, string>): Promise<RawTokenResponse> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
    cache: "no-store",
  });

  const text = await res.text();
  if (!res.ok) {
    let code: string | null = null;
    try {
      const parsed = JSON.parse(text) as { error?: unknown };
      if (typeof parsed.error === "string") code = parsed.error;
    } catch {
      // BASEがJSON以外を返すこともある。その場合はHTTPステータスだけが手がかり。
    }
    // サーバーログには応答本文を残す（原因調査に要る）。送信した
    // パラメータ側は絶対に出さない —— client_secretが入っているため。
    console.error("[base/oauth] token endpoint failed", { status: res.status, code, body: text.slice(0, 500) });
    throw new BaseTokenExchangeError(describeTokenError(code, res.status), code, res.status);
  }

  try {
    return JSON.parse(text) as RawTokenResponse;
  } catch {
    throw new BaseTokenExchangeError("BASEからの応答を解釈できませんでした。時間をおいて再度お試しください。", null, res.status);
  }
}

/**
 * Called once, from the OAuth callback route, with the `code` BASE just
 * handed back. `redirect_uri` は認可を開始したときと同一でなければ
 * ならないので、同じ関数（resolveRedirectUri）で組み立てる。
 */
export async function exchangeCodeForToken(code: string, request: Request): Promise<void> {
  const { clientId, clientSecret } = await requireCredentials();
  const body = await requestToken({
    grant_type: "authorization_code",
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: resolveRedirectUri(request),
    code,
  });
  await saveToken(body.access_token, body.refresh_token, body.expires_in);
}

async function saveToken(accessToken: string, refreshToken: string | undefined, expiresIn: number) {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + expiresIn * 1000).toISOString();
  const { data: existing } = await serverDataClient.models.BaseOAuthToken.get(
    { id: TOKEN_ROW_ID },
    adminAuthMode,
  );

  const finalRefreshToken = refreshToken ?? existing?.refreshToken;
  if (!finalRefreshToken) {
    throw new Error("BASE did not return a refresh_token and none was already stored.");
  }

  if (existing) {
    await serverDataClient.models.BaseOAuthToken.update(
      {
        id: TOKEN_ROW_ID,
        accessToken,
        refreshToken: finalRefreshToken,
        expiresAt,
        updatedAt: now.toISOString(),
      },
      adminAuthMode,
    );
  } else {
    await serverDataClient.models.BaseOAuthToken.create(
      {
        id: TOKEN_ROW_ID,
        accessToken,
        refreshToken: finalRefreshToken,
        expiresAt,
        updatedAt: now.toISOString(),
      },
      adminAuthMode,
    );
  }
}

export class BaseNotConnectedError extends Error {
  constructor() {
    super("BASEアカウントとの連携（OAuth認可）が完了していません。設定 → BASE連携 から「BASEアカウントを連携する」を実行してください。");
    this.name = "BaseNotConnectedError";
  }
}

export async function isBaseConnected(): Promise<boolean> {
  const { data } = await serverDataClient.models.BaseOAuthToken.get({ id: TOKEN_ROW_ID }, adminAuthMode);
  return Boolean(data);
}

/**
 * Returns a valid access token, refreshing first if the stored one is
 * expired (or about to be, within a 60s margin). Every caller of this
 * runs inside an admin-authenticated request — see the BaseItemCache
 * comment in amplify/data/resource.ts for why the public feature page
 * never needs to call this at all.
 */
export async function getAccessToken(): Promise<string> {
  // 「認証情報が無い」と「連携が済んでいない」は別の状態で、次にやる
  // ことが違う。取り違えると設定画面の案内が的外れになるので先に分ける。
  if (!(await getBaseCredentials())) throw new BaseNotConfiguredError();

  const { data: token } = await serverDataClient.models.BaseOAuthToken.get({ id: TOKEN_ROW_ID }, adminAuthMode);
  if (!token) throw new BaseNotConnectedError();

  const expiresAt = new Date(token.expiresAt).getTime();
  if (expiresAt > Date.now() + 60_000) {
    return token.accessToken;
  }

  const { clientId, clientSecret } = await requireCredentials();
  const body = await requestToken({
    grant_type: "refresh_token",
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: token.refreshToken,
  });
  await saveToken(body.access_token, body.refresh_token, body.expires_in);
  return body.access_token;
}

export async function disconnectBase(): Promise<void> {
  const { data: existing } = await serverDataClient.models.BaseOAuthToken.get({ id: TOKEN_ROW_ID }, adminAuthMode);
  if (existing) await serverDataClient.models.BaseOAuthToken.delete({ id: TOKEN_ROW_ID }, adminAuthMode);
}

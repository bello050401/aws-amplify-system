import { adminAuthMode, serverDataClient } from "@/lib/amplify/dataClient";

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
const DEFAULT_SCOPE = "read_items write_items";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set.`);
  return value;
}

/** Where BASE should redirect the shop owner back to after they approve the app. */
export function getRedirectUri(): string {
  return requireEnv("BASE_REDIRECT_URI");
}

/** Builds the URL to send the signed-in admin's browser to, to start the consent flow. */
export function buildAuthorizeUrl(state: string): string {
  const url = new URL(AUTHORIZE_ENDPOINT);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", requireEnv("BASE_CLIENT_ID"));
  url.searchParams.set("redirect_uri", getRedirectUri());
  url.searchParams.set("scope", process.env.BASE_SCOPES ?? DEFAULT_SCOPE);
  url.searchParams.set("state", state);
  return url.toString();
}

interface RawTokenResponse {
  access_token: string;
  refresh_token?: string; // some providers omit this on refresh to mean "unchanged"
  expires_in: number; // seconds
}

async function requestToken(params: Record<string, string>): Promise<RawTokenResponse> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`BASE token endpoint returned ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as RawTokenResponse;
}

/** Called once, from the OAuth callback route, with the `code` BASE just handed back. */
export async function exchangeCodeForToken(code: string): Promise<void> {
  const body = await requestToken({
    grant_type: "authorization_code",
    client_id: requireEnv("BASE_CLIENT_ID"),
    client_secret: requireEnv("BASE_CLIENT_SECRET"),
    redirect_uri: getRedirectUri(),
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
    super("BASEに接続されていません。/admin/settings から接続してください。");
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
  const { data: token } = await serverDataClient.models.BaseOAuthToken.get({ id: TOKEN_ROW_ID }, adminAuthMode);
  if (!token) throw new BaseNotConnectedError();

  const expiresAt = new Date(token.expiresAt).getTime();
  if (expiresAt > Date.now() + 60_000) {
    return token.accessToken;
  }

  const body = await requestToken({
    grant_type: "refresh_token",
    client_id: requireEnv("BASE_CLIENT_ID"),
    client_secret: requireEnv("BASE_CLIENT_SECRET"),
    refresh_token: token.refreshToken,
  });
  await saveToken(body.access_token, body.refresh_token, body.expires_in);
  return body.access_token;
}

export async function disconnectBase(): Promise<void> {
  const { data: existing } = await serverDataClient.models.BaseOAuthToken.get({ id: TOKEN_ROW_ID }, adminAuthMode);
  if (existing) await serverDataClient.models.BaseOAuthToken.delete({ id: TOKEN_ROW_ID }, adminAuthMode);
}

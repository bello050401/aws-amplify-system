import { adminAuthMode, serverDataClient } from "@/lib/amplify/dataClient";
import { unwrapDataResult, AmplifyDataError, type AmplifyDataResult } from "@/lib/amplify/dataResult";
import { getBaseCredentials } from "./secretStore";
import { BaseNotConfiguredError } from "./errors";
import { resolveRedirectUri } from "./redirectUri";
import { createSingleFlight, shouldRetryToken, tokenRetryDelayMs } from "./tokenRetry";
import { resolveScope } from "./scope";
import { fetchWithTimeout } from "@/lib/http/fetchWithTimeout";

/**
 * この経路の外部呼び出し。応答が返らないまま固まらないよう上限を持つ
 * （2026-09-04 健全化 PHASE 8 — lib/http/fetchWithTimeout.ts）。
 * どこが時間切れになったのかがログで分かるよう、名前を付けて渡す。
 */
const fetchExternal = (input: string | URL | Request, init?: RequestInit) =>
  fetchWithTimeout(input, init, { label: "BASEの認証エンドポイント" });


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

/** どちらの経路で失敗したか。同じ `invalid_grant` でも原因が違う。 */
export type TokenGrantKind = "authorization_code" | "refresh_token";

/**
 * BASEのエラーコードを、担当者が次に何をすればよいか分かる日本語にする。
 *
 * `invalid_grant` は経路で意味が変わる。連携時なら「認可コードが古い」で、
 * 更新時なら「リフレッシュトークンが失効した」。どちらも次にやることは
 * 再連携だが、**原因が違うので原因の文言を取り違えると調査が逸れる** ——
 * 更新時に「認可コードが無効です」と出ると、連携手順を疑って何度もやり直す
 * ことになり、本当の原因(トークンの失効・回転の競合)に辿り着けない。
 */
function describeTokenError(code: string | null, status: number | null, grant: TokenGrantKind): string {
  switch (code) {
    case "invalid_client":
      return "BASEがClient ID / Client Secretを受け付けませんでした。設定画面で登録した値がBASE Developersのものと一致しているか確認してください。";
    case "invalid_grant":
      return grant === "refresh_token"
        ? "BASEのアクセストークンを更新できませんでした（リフレッシュトークンが失効しています）。設定画面からもう一度「BASEアカウントを連携する」をやり直してください。"
        : "認可コードが無効か、既に使用済みです。設定画面からもう一度「BASEアカウントを連携する」をやり直してください。";
    case "redirect_uri_mismatch":
      return "コールバックURLがBASE Developersへ登録した値と一致していません。設定画面に表示されているコールバックURLをそのまま登録してください。";
    case "invalid_scope":
      return "要求した権限（スコープ）がBASEアプリに許可されていません。BASE Developers側でread_items / write_itemsを有効にしてください。";
    default:
      return `BASEとのトークン交換に失敗しました（${code ?? `HTTP ${status ?? "不明"}`}）。時間をおいて再度お試しください。`;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * トークンエンドポイントを1回叩く。失敗はすべて BaseTokenExchangeError。
 *
 * ネットワーク層の失敗(DNS・接続断・タイムアウト)は status を null に
 * して包む —— 呼び出し側が「再試行する価値があるか」を同じ形で判定
 * できるようにするため。
 */
async function requestTokenOnce(params: Record<string, string>, grant: TokenGrantKind): Promise<RawTokenResponse> {
  let res: Response;
  try {
    res = await fetchExternal(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params),
      cache: "no-store",
    });
  } catch (err) {
    // 例外そのものは出さない —— fetchの例外メッセージにURLや
    // ヘッダが載る実装があるため。種別だけ記録する。
    console.error("[base/oauth] token endpoint unreachable", { name: err instanceof Error ? err.name : "unknown" });
    throw new BaseTokenExchangeError(
      "BASEへ接続できませんでした。時間をおいて再度お試しください。",
      null,
      null,
    );
  }

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
    throw new BaseTokenExchangeError(describeTokenError(code, res.status, grant), code, res.status);
  }

  try {
    return JSON.parse(text) as RawTokenResponse;
  } catch {
    throw new BaseTokenExchangeError("BASEからの応答を解釈できませんでした。時間をおいて再度お試しください。", null, res.status);
  }
}

/**
 * 一時的な失敗だけ、指数バックオフで再試行する。
 *
 * invalid_grant / invalid_client のような 4xx は**再試行しない** ——
 * 何度投げても同じ答えしか返らないうえ、レート制限に当たって本当に
 * 必要なときの1回を潰す。判定は lib/base/tokenRetry.ts。
 */
async function requestToken(params: Record<string, string>, grant: TokenGrantKind): Promise<RawTokenResponse> {
  let attempt = 0;
  for (;;) {
    attempt++;
    try {
      return await requestTokenOnce(params, grant);
    } catch (err) {
      const status = err instanceof BaseTokenExchangeError ? err.status : null;
      if (!(err instanceof BaseTokenExchangeError) || !shouldRetryToken(attempt, status)) throw err;
      console.warn("[base/oauth] token request retrying", { attempt, status });
      await sleep(tokenRetryDelayMs(attempt));
    }
  }
}

/**
 * Called once, from the OAuth callback route, with the `code` BASE just
 * handed back. `redirect_uri` は認可を開始したときと同一でなければ
 * ならないので、同じ関数（resolveRedirectUri）で組み立てる。
 */
export async function exchangeCodeForToken(code: string, request: Request): Promise<void> {
  const { clientId, clientSecret } = await requireCredentials();
  const body = await requestToken(
    {
      grant_type: "authorization_code",
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: resolveRedirectUri(request),
      code,
    },
    "authorization_code",
  );
  await saveToken(body.access_token, body.refresh_token, body.expires_in);
}

/**
 * トークンの保存・読み出しが失敗したことを表すエラー。
 *
 * 【なぜ専用の型が要るのか — 実機で起きたこと】Amplify Dataの
 * `models.X.create()` / `.update()` / `.get()` は、**認可で拒否されても
 * 例外を投げない**。`{ data: null, errors: [...] }` を返すだけである。
 * この`errors`を見ずに `const { data } = await ...` と分解していたため、
 * OAuth callbackは「保存できた」と判断して緑色の成功表示を出し、
 * 実際にはBaseOAuthTokenテーブルは0行のままだった（両テーブルを
 * scanして確認）。状態表示だけが「未連携」と正しく言っていた。
 *
 * 失敗を必ず例外へ変換して、成功表示が「本当に保存できたこと」だけを
 * 意味するようにする。
 */
export class BaseTokenStorageError extends Error {
  constructor(
    message: string,
    /** 認可拒否か（設定の問題）、それ以外か（一時的な障害の可能性）。 */
    public readonly unauthorized: boolean,
  ) {
    super(message);
    this.name = "BaseTokenStorageError";
  }
}

/**
 * Amplify Dataの戻り値からdataを取り出す。errorsがあれば必ず投げる。
 * 判定そのものは lib/amplify/dataResult.ts の純粋関数（単体検証対象）。
 */
function unwrapTokenResult<T>(result: AmplifyDataResult<T>, operation: string): T {
  try {
    return unwrapDataResult(result, `BaseOAuthToken.${operation}`, {
      unauthorized: "BASEの接続情報を保存・参照する権限がありません。管理者アカウントの権限設定をご確認ください。",
      failed: "BASEの接続情報の保存・参照に失敗しました。時間をおいて再度お試しください。",
    });
  } catch (err) {
    if (err instanceof AmplifyDataError) throw new BaseTokenStorageError(err.message, err.unauthorized);
    throw err;
  }
}

async function saveToken(accessToken: string, refreshToken: string | undefined, expiresIn: number) {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + expiresIn * 1000).toISOString();
  const existing = unwrapTokenResult(
    await serverDataClient.models.BaseOAuthToken.get({ id: TOKEN_ROW_ID }, adminAuthMode),
    "get(before-save)",
  );

  const finalRefreshToken = refreshToken ?? existing?.refreshToken;
  if (!finalRefreshToken) {
    throw new Error("BASE did not return a refresh_token and none was already stored.");
  }

  const row = {
    id: TOKEN_ROW_ID,
    accessToken,
    refreshToken: finalRefreshToken,
    expiresAt,
    updatedAt: now.toISOString(),
  };

  if (existing) {
    unwrapTokenResult(await serverDataClient.models.BaseOAuthToken.update(row, adminAuthMode), "update");
  } else {
    unwrapTokenResult(await serverDataClient.models.BaseOAuthToken.create(row, adminAuthMode), "create");
  }

  // 書き込みが受理されたことと、実際に読み戻せることは別物。
  // 「連携完了」と表示してよいのは後者を確かめてからにする ——
  // 今回の不具合はまさに「保存できたつもり」で成功表示を出していた。
  const saved = unwrapTokenResult(
    await serverDataClient.models.BaseOAuthToken.get({ id: TOKEN_ROW_ID }, adminAuthMode),
    "get(after-save)",
  );
  if (!saved) {
    throw new BaseTokenStorageError("BASEの接続情報を保存できませんでした（保存後に読み戻せませんでした）。", false);
  }
}

export class BaseNotConnectedError extends Error {
  constructor() {
    super("BASEアカウントとの連携（OAuth認可）が完了していません。設定 → BASE連携 から「BASEアカウントを連携する」を実行してください。");
    this.name = "BaseNotConnectedError";
  }
}

/**
 * 保存済みトークンの有無。**読み出しに失敗した場合は投げる** ——
 * 「読めなかった」を「未連携」として表示すると、権限設定の誤りが
 * 「まだ連携していないだけ」に見えてしまい、原因に辿り着けない
 * （呼び出し側の getBaseConnectionState はこれを捕まえて
 * 「確認できませんでした」と区別して表示する）。
 */
export async function isBaseConnected(): Promise<boolean> {
  const data = unwrapTokenResult(
    await serverDataClient.models.BaseOAuthToken.get({ id: TOKEN_ROW_ID }, adminAuthMode),
    "get(is-connected)",
  );
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

  const token = unwrapTokenResult(
    await serverDataClient.models.BaseOAuthToken.get({ id: TOKEN_ROW_ID }, adminAuthMode),
    "get(access-token)",
  );
  if (!token) throw new BaseNotConnectedError();

  // expiresAt が壊れていれば getTime() は NaN になり、この比較は false。
  // つまり「期限が読めないなら更新する」側へ倒れる —— 読めない値を
  // 有効期限内とみなして期限切れトークンを使い続けるより安全。
  const expiresAt = new Date(token.expiresAt).getTime();
  if (expiresAt > Date.now() + 60_000) {
    return token.accessToken;
  }

  // 同時に走らせない。BASEはリフレッシュのたびに refresh_token を回転
  // させることがあり、2本同時だと後から来たほうが**既に無効になった**
  // トークンを送って invalid_grant になる。さらに悪いのは保存の競合で、
  // 古いトークンで上書きすると連携そのものが壊れ、**人による再連携**が
  // 必要になる。BASEの再認証は人しかできないので、そこへ落とさない。
  // (効くのは同一プロセス内まで。理由は lib/base/tokenRetry.ts に書いた)
  return refreshInFlight(async () => {
    const { clientId, clientSecret } = await requireCredentials();
    const body = await requestToken(
      {
        grant_type: "refresh_token",
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: token.refreshToken,
      },
      "refresh_token",
    );
    await saveToken(body.access_token, body.refresh_token, body.expires_in);
    return body.access_token;
  });
}

/** 更新の同時実行を1本に畳む。モジュールスコープ = プロセス単位。 */
const refreshInFlight = createSingleFlight<string>();

export async function disconnectBase(): Promise<void> {
  const existing = unwrapTokenResult(
    await serverDataClient.models.BaseOAuthToken.get({ id: TOKEN_ROW_ID }, adminAuthMode),
    "get(before-disconnect)",
  );
  if (existing) {
    unwrapTokenResult(await serverDataClient.models.BaseOAuthToken.delete({ id: TOKEN_ROW_ID }, adminAuthMode), "delete");
  }
}

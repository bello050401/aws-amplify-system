/**
 * BASE OAuthの `redirect_uri` を決める。
 *
 * 【なぜ環境変数だけでは足りないか】`redirect_uri` は3か所で完全一致して
 * いなければならない —— BASE Developersへ登録した値、認可URLに載せる値、
 * トークン交換で送る値。1文字でも違うと `redirect_uri_mismatch` になる。
 * それを手で3回揃えさせるのは、間違えたときに原因が最も分かりにくい
 * 種類の設定ミスなので、**アプリ自身が自分のURLから組み立てて、画面には
 * 「これをBASEへ登録してください」とコピーできる形で出す**。
 *
 * 環境変数 `BASE_REDIRECT_URI` は「明示的な上書き」として残す。
 * 独自ドメインを当てた場合や、ローカル開発で localhost を使う場合に必要。
 *
 * 【リクエストから組み立てる際の注意】Amplify HostingのSSRはCloudFrontの
 * 背後にあり、`request.url` のhostが内部のものになり得る。ブラウザが
 * 実際に見ているホストは `x-forwarded-host` に入るので、あればそちらを
 * 優先する。
 */

export const OAUTH_CALLBACK_PATH = "/api/base/oauth/callback";

/** ブラウザから見たこのアプリのオリジン（例: https://xxx.amplifyapp.com）。 */
export function resolveAppOrigin(request: Request): string {
  const headers = request.headers;
  const forwardedHost = headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const host = forwardedHost || headers.get("host")?.trim();
  if (host) {
    const proto = headers.get("x-forwarded-proto")?.split(",")[0]?.trim() || (host.startsWith("localhost") ? "http" : "https");
    return `${proto}://${host}`;
  }
  return new URL(request.url).origin;
}

/**
 * 認可URL・トークン交換の両方で使う `redirect_uri`。
 * **同じリクエスト系列で必ず同じ値になること**が正しさの条件なので、
 * 上書きの優先順位はここ1か所だけで決める。
 */
export function resolveRedirectUri(request: Request): string {
  const override = process.env.BASE_REDIRECT_URI?.trim();
  if (override) return override;
  return `${resolveAppOrigin(request)}${OAUTH_CALLBACK_PATH}`;
}

/**
 * 設定画面に「BASE Developersへ登録する値」として表示するためのもの。
 * リクエストが手元にないServer Component/Actionからも呼べるよう、
 * ホストを引数で受ける。
 */
export function buildRedirectUriFromHost(host: string | null): string | null {
  const override = process.env.BASE_REDIRECT_URI?.trim();
  if (override) return override;
  const trimmed = host?.trim();
  if (!trimmed) return null;
  const proto = trimmed.startsWith("localhost") || trimmed.startsWith("127.0.0.1") ? "http" : "https";
  return `${proto}://${trimmed}${OAUTH_CALLBACK_PATH}`;
}

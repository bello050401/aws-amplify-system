import { resolveAppOrigin } from "@/lib/http/appOrigin";

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

// オリジンの解決自体はBASE固有ではない（管理画面のログインリダイレクトも
// 同じ問題を持っていた）ので lib/http/appOrigin.ts に置いてある。
export { resolveAppOrigin };

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

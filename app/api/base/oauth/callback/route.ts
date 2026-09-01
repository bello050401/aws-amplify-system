import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { exchangeCodeForToken, BaseTokenExchangeError } from "@/lib/base/oauth";
import { BaseNotConfiguredError } from "@/lib/base/errors";
import { requireAdminOrRedirect } from "@/lib/amplify/requireAdmin";

const STATE_COOKIE = "base_oauth_state";

/**
 * GET /api/base/oauth/callback — this is exactly the URL to register as
 * the app's "Callback URL" in BASE Developers. BASE redirects the admin's
 * browser here with `?code=...&state=...` after they approve the app.
 *
 * 戻り先は設定 → BASE連携タブ。以前は /admin/settings へ戻していたが、
 * 接続操作を行う画面は /inventory/settings のBASE連携タブなので、
 * 操作を始めた場所へ結果を持って戻る。
 */
export async function GET(request: Request) {
  const denied = await requireAdminOrRedirect(request);
  if (denied) return denied;

  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const expectedState = cookies().get(STATE_COOKIE)?.value;
  cookies().delete(STATE_COOKIE);

  const settingsUrl = new URL("/inventory/settings", request.url);
  settingsUrl.searchParams.set("tab", "base");

  const denialCode = url.searchParams.get("error");
  if (denialCode) {
    settingsUrl.searchParams.set(
      "baseError",
      denialCode === "access_denied"
        ? "BASEの認可画面でアクセスが許可されませんでした。もう一度お試しください。"
        : `BASEの認可画面がエラーを返しました（${denialCode}）。BASE Developersのアプリ設定（コールバックURL・利用権限）をご確認ください。`,
    );
    return NextResponse.redirect(settingsUrl);
  }

  // CSRF対策: 認可を開始したのがこのブラウザ自身であることの確認。
  // 期限切れ(10分)でもここに来るので、文言は「やり直してください」にする。
  if (!code || !state || !expectedState || state !== expectedState) {
    settingsUrl.searchParams.set(
      "baseError",
      "認可の照合に失敗しました（時間が経ちすぎたか、別のタブで開始された可能性があります）。もう一度「BASEアカウントを連携する」からやり直してください。",
    );
    return NextResponse.redirect(settingsUrl);
  }

  try {
    await exchangeCodeForToken(code, request);
    settingsUrl.searchParams.set("baseConnected", "1");
  } catch (err) {
    // 利用者へ出すのは日本語に畳んだ説明だけ。BASEの応答本文や送信内容は
    // サーバーログにのみ残す(lib/base/oauth.ts の requestToken 参照)。
    if (err instanceof BaseTokenExchangeError || err instanceof BaseNotConfiguredError) {
      settingsUrl.searchParams.set("baseError", err.message);
    } else {
      console.error("[base/oauth/callback] unexpected error:", err instanceof Error ? `${err.name}: ${err.message}` : String(err));
      settingsUrl.searchParams.set("baseError", "BASEとの連携中に予期しないエラーが発生しました。時間をおいて再度お試しください。");
    }
  }

  return NextResponse.redirect(settingsUrl);
}

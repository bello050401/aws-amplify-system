import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { exchangeCodeForToken, BaseTokenExchangeError } from "@/lib/base/oauth";
import { BaseNotConfiguredError } from "@/lib/base/errors";
import { resolveAppOrigin } from "@/lib/base/redirectUri";
import { getInventoryRole } from "@/lib/amplify/requireInventoryUser";

const STATE_COOKIE = "base_oauth_state";

/**
 * GET /api/base/oauth/callback — BASE Developersへ「コールバックURL」として
 * 登録するのはまさにこのURL。BASEは承認後、`?code=...&state=...` を付けて
 * 管理者のブラウザをここへ戻す。
 *
 * 門と戻り先の考え方は start/route.ts と同じ（同じ理由で
 * getInventoryRole と x-forwarded-host を使う）。
 */
export async function GET(request: Request) {
  const origin = resolveAppOrigin(request);
  const settingsUrl = new URL("/inventory/settings", origin);
  settingsUrl.searchParams.set("tab", "base");

  if ((await getInventoryRole()) !== "ADMIN") {
    // /inventory/login は redirect パラメータを解釈しないので付けない。
    // そもそも設定画面を開けている時点で署名済みなので、ここは防御的な経路。
    return NextResponse.redirect(new URL("/inventory/login", origin));
  }

  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const expectedState = cookies().get(STATE_COOKIE)?.value;
  cookies().delete(STATE_COOKIE);

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

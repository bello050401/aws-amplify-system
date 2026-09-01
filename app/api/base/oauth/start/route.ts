import { randomUUID } from "crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { buildAuthorizeUrl } from "@/lib/base/oauth";
import { BaseNotConfiguredError } from "@/lib/base/errors";
import { resolveAppOrigin } from "@/lib/base/redirectUri";
import { getInventoryRole } from "@/lib/amplify/requireInventoryUser";

const STATE_COOKIE = "base_oauth_state";

/**
 * GET /api/base/oauth/start — 「BASEアカウントを連携する」ボタンの遷移先。
 * ブラウザ自体をBASEの認可画面へ送る必要があるので、Server Actionでは
 * なくRoute Handlerになっている。
 *
 * ## 認可の門は inventory の ADMIN
 *
 * 以前は requireAdminOrRedirect（Cognitoグループ `Admins`）で守っていたが、
 * このボタンを置いている /inventory/settings は `getInventoryRole()`
 * （グループ `ADMIN`）で守られている **別の権限体系** だった。
 * 実測: このユーザープールの利用者は `ADMIN` にのみ所属しており
 * `Admins` には入っていない。つまり設定画面には入れるのに、ボタンを
 * 押した瞬間だけ /admin/login へ弾かれる状態だった。
 * ボタンを表示する画面と同じ門にする。
 *
 * ## リダイレクト先はヘッダから組み立てる
 *
 * Amplify HostingのSSRでは `request.url` のホストが `localhost:3000` に
 * なる（実測: 本番URLへのcurlに対し Location: https://localhost:3000/... が
 * 返っていた）。`new URL(path, request.url)` で作った戻り先は
 * ブラウザから到達できないので、x-forwarded-host から組み立てる。
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

  const state = randomUUID();

  let authorizeUrl: string;
  try {
    authorizeUrl = await buildAuthorizeUrl(state, request);
  } catch (err) {
    settingsUrl.searchParams.set(
      "baseError",
      err instanceof BaseNotConfiguredError
        ? "アプリ認証情報が未登録のため、BASEの認可画面へ進めません。先にClient ID / Client Secretを登録してください。"
        : "BASEの認可画面へ進めませんでした。時間をおいて再度お試しください。",
    );
    return NextResponse.redirect(settingsUrl);
  }

  // cookieを立てるのは認可URLの組み立てに成功した後だけ。失敗経路で
  // 立ててしまうと、次の正規の試行のstateと食い違う余地が生まれる。
  cookies().set(STATE_COOKIE, state, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: 600,
    path: "/",
  });

  return NextResponse.redirect(authorizeUrl);
}

import { randomUUID } from "crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { buildAuthorizeUrl } from "@/lib/base/oauth";
import { BaseNotConfiguredError } from "@/lib/base/errors";
import { requireAdminOrRedirect } from "@/lib/amplify/requireAdmin";

const STATE_COOKIE = "base_oauth_state";

/**
 * GET /api/base/oauth/start — the "BASEアカウントを連携する" button target.
 * Only a signed-in admin can trigger this (checked below): it sends their
 * browser to BASE's consent screen, which only the actual shop owner can
 * approve — that's the one step in this whole flow that genuinely has to
 * be a human clicking through BASE's own UI.
 *
 * 失敗したら設定画面へ理由付きで戻す。以前は認証情報が無いと
 * `requireEnv` が素の Error を投げ、利用者にはNext.jsの500画面しか
 * 見えなかった —— 何をすればよいか分からない状態になる。
 */
export async function GET(request: Request) {
  const denied = await requireAdminOrRedirect(request);
  if (denied) return denied;

  const settingsUrl = new URL("/inventory/settings", request.url);
  settingsUrl.searchParams.set("tab", "base");

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

import { randomUUID } from "crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { buildAuthorizeUrl } from "@/lib/base/oauth";
import { requireAdminOrRedirect } from "@/lib/amplify/requireAdmin";

const STATE_COOKIE = "base_oauth_state";

/**
 * GET /api/base/oauth/start — the "BASEと接続する" button target. Only a
 * signed-in admin can trigger this (checked below): it sends their
 * browser to BASE's consent screen, which only the actual shop owner can
 * approve — that's the one step in this whole flow that genuinely has to
 * be a human clicking through BASE's own UI.
 */
export async function GET(request: Request) {
  const denied = await requireAdminOrRedirect(request);
  if (denied) return denied;

  const state = randomUUID();
  cookies().set(STATE_COOKIE, state, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: 600,
    path: "/",
  });

  return NextResponse.redirect(buildAuthorizeUrl(state));
}

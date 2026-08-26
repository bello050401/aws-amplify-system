import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { exchangeCodeForToken } from "@/lib/base/oauth";
import { requireAdminOrRedirect } from "@/lib/amplify/requireAdmin";

const STATE_COOKIE = "base_oauth_state";

/**
 * GET /api/base/oauth/callback — this is exactly the URL to register as
 * the app's "Callback URL" in BASE Developers. BASE redirects the admin's
 * browser here with `?code=...&state=...` after they approve the app.
 */
export async function GET(request: Request) {
  const denied = await requireAdminOrRedirect(request);
  if (denied) return denied;

  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const expectedState = cookies().get(STATE_COOKIE)?.value;
  cookies().delete(STATE_COOKIE);

  const settingsUrl = new URL("/admin/settings", request.url);

  if (url.searchParams.get("error")) {
    settingsUrl.searchParams.set("error", url.searchParams.get("error") ?? "denied");
    return NextResponse.redirect(settingsUrl);
  }

  if (!code || !state || !expectedState || state !== expectedState) {
    settingsUrl.searchParams.set("error", "invalid_state");
    return NextResponse.redirect(settingsUrl);
  }

  try {
    await exchangeCodeForToken(code);
    settingsUrl.searchParams.set("connected", "1");
  } catch (err) {
    settingsUrl.searchParams.set("error", err instanceof Error ? err.message : "unknown");
  }

  return NextResponse.redirect(settingsUrl);
}

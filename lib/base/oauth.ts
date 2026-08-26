import type { BaseTokenSet } from "./types";

/**
 * BASE OAuth2 token refresh.
 *
 * ⚠️ UNCONFIRMED ENDPOINTS — see docs/NOTES_BASE_API.md
 * The URLs below are placeholders based on BASE's publicly known API host
 * (`api.thebase.in`) and standard OAuth2 `grant_type=refresh_token` shape.
 * They have NOT been verified against the live API from this environment
 * (network egress to thebase.in is blocked here). Do not point real
 * traffic at this file until someone with a working BASE API app has
 * confirmed:
 *   - the token endpoint path
 *   - the exact param names BASE expects
 *   - the response body shape (field names for access/refresh token + TTL)
 */
const TOKEN_ENDPOINT = "https://api.thebase.in/1/oauth/token"; // TODO confirm

interface RawTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number; // seconds
}

let cached: BaseTokenSet | null = null;

export async function getAccessToken(): Promise<string> {
  if (cached && cached.expiresAt > Date.now() + 60_000) {
    return cached.accessToken;
  }
  cached = await refreshAccessToken();
  return cached.accessToken;
}

async function refreshAccessToken(): Promise<BaseTokenSet> {
  const clientId = process.env.BASE_CLIENT_ID;
  const clientSecret = process.env.BASE_CLIENT_SECRET;
  const refreshToken = process.env.BASE_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      "BASE_CLIENT_ID / BASE_CLIENT_SECRET / BASE_REFRESH_TOKEN must be set to refresh a real BASE access token.",
    );
  }

  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
    }),
    cache: "no-store",
  });

  if (!res.ok) {
    throw new Error(`BASE token refresh failed: ${res.status} ${await res.text()}`);
  }

  const body = (await res.json()) as RawTokenResponse;
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresAt: Date.now() + body.expires_in * 1000,
  };
}

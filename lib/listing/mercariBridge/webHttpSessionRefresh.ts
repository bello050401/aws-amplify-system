import "server-only";
import { openMercariWebHttpCookieReadOnly } from "./webHttpReadOnlyClient.ts";

export const SHOPS_REFRESH_URL = "https://mercari-shops.com/auth/token/refresh";
const GRAPHQL_COOKIES = ["id_token", "__cf_bm", "_cfuvid"];
const REFRESH_COOKIES = ["refresh_token", "device_id", "device_token", "gateway_client_uuid", "__cf_bm", "_cfuvid"];
export type RefreshMaterial = { cookieHeader: string; refreshCookieHeader: string;
  refreshExpiresAtMs: number; deviceExpiresAtMs: number };
export type RefreshedSession = RefreshMaterial & { expiresAtMs: number };

function cookieMap(header: unknown, allowed: string[]): Map<string, string> | null {
  if (typeof header !== "string" || !header || header.length > 32_768 || /[\r\n\0]/.test(header)) return null;
  const cookies = new Map<string, string>();
  for (const part of header.split(";")) {
    const s = part.trim(), index = s.indexOf("="), name = s.slice(0, index), value = s.slice(index + 1);
    if (index < 1 || !value || !allowed.includes(name) || cookies.has(name)) return null;
    cookies.set(name, value);
  }
  return cookies;
}
const headerFor = (map: Map<string, string>) => [...map].map(([k, v]) => `${k}=${v}`).join("; ");
function claims(token: string | undefined): { sub: string; iss: string; exp: number } | null {
  try {
    if (!token || token.split(".").length !== 3) return null;
    const c = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    return typeof c.sub === "string" && c.sub && typeof c.iss === "string" && c.iss &&
      Number.isSafeInteger(c.exp * 1000) ? c : null;
  } catch { return null; }
}
export function parseRefreshMaterial(value: unknown, now = Date.now()): RefreshMaterial | null {
  if (!value || typeof value !== "object") return null;
  const v = value as RefreshMaterial;
  const current = cookieMap(v.cookieHeader, GRAPHQL_COOKIES), refresh = cookieMap(v.refreshCookieHeader, REFRESH_COOKIES);
  if (!current || !claims(current.get("id_token")) || !refresh ||
      !["refresh_token", "device_id", "device_token"].every(name => refresh.has(name)) ||
      !Number.isSafeInteger(v.refreshExpiresAtMs) || v.refreshExpiresAtMs <= now + 40_000 ||
      !Number.isSafeInteger(v.deviceExpiresAtMs) || v.deviceExpiresAtMs < v.refreshExpiresAtMs ||
      v.refreshExpiresAtMs > 8_640_000_000_000_000) return null;
  return { cookieHeader: v.cookieHeader, refreshCookieHeader: v.refreshCookieHeader,
    refreshExpiresAtMs: v.refreshExpiresAtMs, deviceExpiresAtMs: v.deviceExpiresAtMs };
}

/** Only exact HTTPS cookie scopes observed in the supplied refresh capture.
 * Cookie claims are bounds, not proof of authentication; live verification follows.
 */
export function refreshedCookies(material: RefreshMaterial, headers: string[], now: number): RefreshedSession | null {
  const current = cookieMap(material.cookieHeader, GRAPHQL_COOKIES), refresh = cookieMap(material.refreshCookieHeader, REFRESH_COOKIES);
  if (!current || !refresh || !Array.isArray(headers)) return null;
  const oldClaims = claims(current.get("id_token"));
  const received = new Map<string, { value: string; expiresAt: number }>();
  for (const header of headers) {
    if (typeof header !== "string" || /[\r\n\0]/.test(header)) return null;
    const [pair, ...parts] = header.split(";");
    const equal = pair.indexOf("="), name = pair.slice(0, equal).trim(), value = pair.slice(equal + 1).trim();
    if (!["id_token", "refresh_token"].includes(name)) continue;
    if (equal < 1 || !value || received.has(name)) return null;
    const attrs = new Map(parts.map(p => { const i = p.indexOf("=");
      return i < 0 ? [p.trim().toLowerCase(), ""] : [p.slice(0, i).trim().toLowerCase(), p.slice(i + 1).trim()]; }));
    if (!attrs.has("httponly") || attrs.get("path") !== (name === "id_token" ? "/" : "/auth/token/refresh") ||
        (attrs.has("domain") && !["mercari-shops.com", ".mercari-shops.com"].includes(attrs.get("domain")!))) return null;
    const age = Number(attrs.get("max-age"));
    if (!attrs.has("max-age") || !Number.isSafeInteger(age) || age <= 0 || age > 400 * 86400) return null;
    received.set(name, { value, expiresAt: now + age * 1000 });
  }
  const id = received.get("id_token"), renewed = received.get("refresh_token"), nextClaims = claims(id?.value);
  if (!id || !renewed || !oldClaims || !nextClaims || oldClaims.sub !== nextClaims.sub || oldClaims.iss !== nextClaims.iss)
    return null;
  const expiresAtMs = Math.min(id.expiresAt, nextClaims.exp * 1000);
  if (expiresAtMs <= now + 60_000) return null;
  current.set("id_token", id.value); refresh.set("refresh_token", renewed.value);
  // Keep the original device-cookie bound even when the refresh token rotates.
  return { cookieHeader: headerFor(current), refreshCookieHeader: headerFor(refresh), expiresAtMs,
    refreshExpiresAtMs: Math.min(material.deviceExpiresAtMs, renewed.expiresAt), deviceExpiresAtMs: material.deviceExpiresAtMs };
}

/** One ordinary refresh request, then authenticated Self and shop reads.
 * No redirects, challenges, retries, browser profiles or product mutations.
 */
export async function refreshWebHttpSessionOnce(material: RefreshMaterial,
  fetchPort: typeof fetch = fetch, clock = Date.now): Promise<RefreshedSession | null> {
  if (!parseRefreshMaterial(material, clock())) return null;
  try {
    const response = await fetchPort(SHOPS_REFRESH_URL, { method: "POST", redirect: "manual",
      credentials: "omit", cache: "no-store", signal: AbortSignal.timeout(10_000),
      headers: { Cookie: material.refreshCookieHeader, Accept: "*/*",
        Origin: "https://mercari-shops.com", Referer: "https://mercari-shops.com/" } });
    if (response.status !== 200 || !response.headers.getSetCookie) return null;
    const renewed = refreshedCookies(material, response.headers.getSetCookie(), clock());
    if (!renewed) return null;
    const opened = await openMercariWebHttpCookieReadOnly(renewed, { fetchPort, clock });
    return opened.client && (await opened.client.verifyTargetShop()).shopMatched ? renewed : null;
  } catch { return null; }
}

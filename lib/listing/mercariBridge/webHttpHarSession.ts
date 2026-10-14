import "server-only";
import { WEB_HTTP_SHOP_ID } from "./webHttpDraftJob.ts";
import { parseRuntimeSession } from "./webHttpRuntime.ts";
import { parseRefreshMaterial, refreshedCookies, SHOPS_REFRESH_URL } from "./webHttpSessionRefresh.ts";

/** Read only an explicitly supplied HAR, never a browser profile. Returned
 * material is secret and must go straight to the dedicated secret store.
 */
export function sessionFromProvidedHar(har: unknown, now = Date.now()) {
  const entries = (har as { log?: { entries?: unknown[] } })?.log?.entries;
  if (!Array.isArray(entries) || entries.length > 100_000) return null;
  let chosen: { cookieHeader: string; expiresAtMs: number; startedAtMs: number } | null = null;
  for (const entry of entries) {
    const e = entry as { startedDateTime?: string; request?: { url?: string; method?: string;
      headers?: { name?: string; value?: string }[]; cookies?: { name?: string; value?: string }[] } };
    if (e?.request?.url !== "https://mercari-shops.com/graphql" || e.request.method !== "POST") continue;
    const startedAtMs = Date.parse(e.startedDateTime ?? "");
    if (!Number.isFinite(startedAtMs) || startedAtMs > now + 60_000) continue;
    const headers = e.request.headers;
    const cookieHeaders = Array.isArray(headers) ? headers.filter(h =>
      h && typeof h.name === "string" && h.name.toLowerCase() === "cookie") : [];
    if (cookieHeaders.length > 1) continue;
    const header = cookieHeaders[0]?.value;
    let cookies: { name?: string; value?: string }[] = [];
    if (typeof header === "string") {
      if (header.length > 64_000 || /[\r\n\0]/.test(header)) continue;
      cookies = header.split(";").map(part => { const i = part.trim().indexOf("=");
        return i < 1 ? {} : { name: part.trim().slice(0, i), value: part.trim().slice(i + 1) }; });
    } else if (Array.isArray(e.request.cookies)) cookies = e.request.cookies;
    const selected = cookies.filter(c => c && ["id_token", "__cf_bm", "_cfuvid"].includes(c.name ?? ""));
    if (!selected.every(c => typeof c.value === "string" && c.value && !/[;\r\n\0]/.test(c.value)) ||
        new Set(selected.map(c => c.name)).size !== selected.length) continue;
    const idToken = selected.find(c => c.name === "id_token")?.value;
    if (!idToken || idToken.split(".").length !== 3) continue;
    let expiry: number;
    try { expiry = JSON.parse(Buffer.from(idToken.split(".")[1], "base64url").toString("utf8")).exp * 1000; }
    catch { continue; }
    // Claims supply an upper bound only; a live Self/OwnShops check is required.
    if (!Number.isSafeInteger(expiry) || expiry <= now + 60_000 || expiry > 8_640_000_000_000_000) continue;
    const cookieHeader = selected.map(c => `${c.name}=${c.value}`).join("; ");
    const record = { schemaVersion: 1, shopId: WEB_HTTP_SHOP_ID,
      authenticatedAt: new Date(now).toISOString(), expiresAt: new Date(expiry).toISOString(),
      opaqueMaterial: JSON.stringify({ cookieHeader }) };
    if (!parseRuntimeSession(record, now)) continue;
    if (!chosen || startedAtMs > chosen.startedAtMs) chosen = { cookieHeader, expiresAtMs: expiry, startedAtMs };
  }
  if (!chosen) return null;
  const session = { cookieHeader: chosen.cookieHeader, expiresAtMs: chosen.expiresAtMs };
  // A GraphQL request never carries the path-scoped refresh/device cookies.
  // Import them only from a successful ordinary refresh captured by the user,
  // using the response's rotated token, never replaying the request's old token.
  for (const entry of [...entries].reverse()) {
    const e = entry as { startedDateTime?: string; request?: { url?: string; method?: string;
      cookies?: { name: string; value: string; domain?: string; path?: string; expires?: string }[] };
      response?: { status?: number; headers?: { name: string; value: string }[] } };
    if (e.request?.url !== SHOPS_REFRESH_URL || e.request.method !== "POST" || e.response?.status !== 200 ||
        !Array.isArray(e.request.cookies) || !Array.isArray(e.response.headers)) continue;
    const capturedAt = Date.parse(e.startedDateTime ?? "");
    if (!Number.isFinite(capturedAt) || capturedAt > now || capturedAt > chosen.startedAtMs) continue;
    const allowed = ["refresh_token", "device_id", "device_token", "gateway_client_uuid", "__cf_bm", "_cfuvid"];
    const cookies = e.request.cookies.filter(c => allowed.includes(c.name));
    if (cookies.some(c => typeof c.value !== "string" || /[;\r\n\0]/.test(c.value))) continue;
    const find = (name: string) => cookies.find(c => c.name === name);
    const device = [find("device_id"), find("device_token")];
    const token = find("refresh_token");
    if (!token || token.path !== "/auth/token/refresh" || device.some(c => !c || c.path !== "/auth") ||
        [token, ...device].some(c => !["mercari-shops.com", ".mercari-shops.com"].includes(c?.domain ?? ""))) continue;
    const deviceExpiresAtMs = Math.min(...device.map(c => Date.parse(c!.expires ?? "")));
    const material = parseRefreshMaterial({ cookieHeader: chosen.cookieHeader,
      refreshCookieHeader: cookies.map(c => `${c.name}=${c.value}`).join("; "), deviceExpiresAtMs,
      refreshExpiresAtMs: Math.min(deviceExpiresAtMs, Date.parse(token.expires ?? "")) }, capturedAt);
    if (!material) continue;
    const renewed = refreshedCookies(material, e.response.headers.filter(h => h.name.toLowerCase() === "set-cookie")
      .map(h => h.value), capturedAt);
    // Same authenticated ID as the latest successful capture, with the latest CF cookies.
    const tokenValue = (s: string) => s.split(";").map(s => s.trim()).find(s => s.startsWith("id_token="));
    if (renewed && tokenValue(renewed.cookieHeader) === tokenValue(chosen.cookieHeader) && parseRefreshMaterial(renewed, now))
      return { ...renewed, ...session };
  }
  return session;
}

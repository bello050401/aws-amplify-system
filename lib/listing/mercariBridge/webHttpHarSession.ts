import "server-only";
import { WEB_HTTP_SHOP_ID } from "./webHttpDraftJob.ts";
import { parseRuntimeSession } from "./webHttpRuntime.ts";

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
  return chosen ? { cookieHeader: chosen.cookieHeader, expiresAtMs: chosen.expiresAtMs } : null;
}

import "server-only";

import { WEB_HTTP_SHOP_ID } from "./webHttpDraftJob.ts";
import { B005396_CORRECT_DRAFT_ID, B005396_EMPTY_DRAFT_ID } from
  "./webHttpObservedDraftRead.ts";

const ORIGIN = "https://mercari-shops.com";
const IDP_URL = `${ORIGIN}/auth/signin/idp`;
const GRAPHQL_URL = `${ORIGIN}/graphql`;
const SELF_QUERY = `query Self { self { accountId } }`;
const SHOPS_QUERY = `query OwnShops { ownShops { id } }`;
const DRAFT_QUERY = `query GetProductDraft($id: String!) {
  productDraft(id: $id) { id }
}`;

type FetchPort = typeof fetch;
type Status = "READY" | "AUTH_REQUIRED" | "COOKIE_UNVERIFIED" |
  "REMOTE_UNVERIFIED";
type ReadStatus = "VERIFIED" | "AUTH_REQUIRED" | "SHOP_MISMATCH" |
  "REMOTE_UNVERIFIED";
type Cookie = { name: string; value: string; expiresAt: number | null };
type GraphqlResult = { status: number; body: unknown } | null;
type CookieIssue = "HEADER_API_UNAVAILABLE" | "ID_COOKIE_MISSING" |
  "ID_COOKIE_VALUE_INVALID" | "ID_COOKIE_DOMAIN_MISMATCH" |
  "ID_COOKIE_PATH_MISMATCH" | "ID_COOKIE_EXPIRY_INVALID" |
  "ID_COOKIE_EXPIRED" | "ID_COOKIE_DUPLICATE";

export type WebHttpIdpCredentials = { idToken: string; refreshToken: string };
export type WebHttpReadOnlyClient = {
  verifyTargetShop: () => Promise<{ status: ReadStatus; shopMatched: boolean }>;
  readKnownB005396Drafts: () => Promise<{
    status: ReadStatus; correctDraftMatched: boolean;
    emptyDraftMatched: boolean;
  }>;
};
export type WebHttpOpenResult = { status: Status;
  client: WebHttpReadOnlyClient | null;
  cookieExpiryKnown: boolean; cookieIssue: CookieIssue | null };

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const safeToken = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length < 32_768 &&
  !/[\r\n\0]/.test(value);

function parseCookie(header: string, now: number):
  { cookie: Cookie; issue: null } | { cookie: null; issue: CookieIssue } {
  const parts = header.split(";").map(part => part.trim());
  const separator = parts[0]?.indexOf("=") ?? -1;
  if (separator < 1) return { cookie: null,
    issue: "ID_COOKIE_VALUE_INVALID" };
  const name = parts[0].slice(0, separator);
  const value = parts[0].slice(separator + 1);
  if (!/^[A-Za-z0-9_]+$/.test(name) || !value ||
      /[\x00-\x20;,\\]/.test(value)) return { cookie: null,
        issue: "ID_COOKIE_VALUE_INVALID" };
  let path = "/auth/signin"; // RFC default path for /auth/signin/idp.
  let domain: string | null = null;
  let expiresAt: number | null = null;
  let maxAge: number | null = null;
  for (const attribute of parts.slice(1)) {
    const index = attribute.indexOf("=");
    const key = (index < 0 ? attribute : attribute.slice(0, index)).toLowerCase();
    const item = index < 0 ? "" : attribute.slice(index + 1);
    if (key === "path") path = item;
    if (key === "domain") domain = item.toLowerCase().replace(/^\./, "");
    if (key === "expires") {
      const date = Date.parse(item);
      if (!Number.isFinite(date)) return { cookie: null,
        issue: "ID_COOKIE_EXPIRY_INVALID" };
      expiresAt = date;
    }
    if (key === "max-age") {
      if (!/^-?\d+$/.test(item)) return { cookie: null,
        issue: "ID_COOKIE_EXPIRY_INVALID" };
      const seconds = Number(item);
      if (!Number.isSafeInteger(seconds)) return { cookie: null,
        issue: "ID_COOKIE_EXPIRY_INVALID" };
      maxAge = seconds;
    }
  }
  if (maxAge !== null) expiresAt = now + maxAge * 1000;
  if (expiresAt !== null && !Number.isSafeInteger(expiresAt))
    return { cookie: null, issue: "ID_COOKIE_EXPIRY_INVALID" };
  if (domain !== null && domain !== "mercari-shops.com")
    return { cookie: null, issue: "ID_COOKIE_DOMAIN_MISMATCH" };
  if (path !== "/" && path !== "/graphql")
    return { cookie: null, issue: "ID_COOKIE_PATH_MISMATCH" };
  if (expiresAt !== null && expiresAt <= now)
    return { cookie: null, issue: "ID_COOKIE_EXPIRED" };
  // Calls are fixed to HTTPS. A missing Secure attribute does not make this
  // process-local cookie unsafe to send to the fixed HTTPS GraphQL endpoint.
  return { cookie: { name, value, expiresAt }, issue: null };
}

function validGraphql(result: GraphqlResult): Record<string, unknown> | null {
  if (!result || result.status !== 200 || !object(result.body) ||
      "errors" in result.body || !object(result.body.data)) return null;
  return result.body.data;
}

/**
 * An observed IDP handoff and a short-lived, process-local, read-only session.
 * Inputs must be raw token strings supplied by a trusted server caller. This
 * module neither acquires login credentials nor persists tokens or cookies.
 */
export async function openMercariWebHttpReadOnly(
  credentials: WebHttpIdpCredentials,
  options: { fetchPort?: FetchPort; clock?: () => number } = {},
): Promise<WebHttpOpenResult> {
  const failed = (status: Status): WebHttpOpenResult =>
    ({ status, client: null, cookieExpiryKnown: false, cookieIssue: null });
  if (!safeToken(credentials?.idToken) ||
      !safeToken(credentials?.refreshToken)) return failed("AUTH_REQUIRED");
  const fetchPort = options.fetchPort ?? fetch;
  const clock = options.clock ?? Date.now;
  const now = clock();
  if (!Number.isSafeInteger(now) || now < 0) return failed("REMOTE_UNVERIFIED");
  const body = new URLSearchParams();
  // Public seller code percent-encodes each raw token before form encoding.
  body.set("idToken", encodeURIComponent(credentials.idToken));
  body.set("refreshToken", encodeURIComponent(credentials.refreshToken));
  let response: Response;
  try {
    response = await fetchPort(IDP_URL, { method: "POST", redirect: "manual",
      credentials: "omit", cache: "no-store", signal: AbortSignal.timeout(10_000),
      headers: { "Content-Type": "application/x-www-form-urlencoded",
        Accept: "text/plain" }, body: body.toString() });
  } catch { return failed("REMOTE_UNVERIFIED"); }
  if (response.status === 401 || response.status === 403)
    return failed("AUTH_REQUIRED");
  if (response.status !== 200 || response.redirected)
    return failed("REMOTE_UNVERIFIED");
  // Never use a combined Set-Cookie string: Expires commas are ambiguous.
  const getSetCookie = (response.headers as Headers & {
    getSetCookie?: () => string[] }).getSetCookie;
  if (typeof getSetCookie !== "function") return { ...failed("COOKIE_UNVERIFIED"),
    cookieIssue: "HEADER_API_UNAVAILABLE" };
  const headers = getSetCookie.call(response.headers);
  const cookieNow = clock();
  if (!Number.isSafeInteger(cookieNow) || cookieNow < now)
    return failed("COOKIE_UNVERIFIED");
  const cookies: Cookie[] = [];
  let idCookieHeaderCount = 0;
  let idCookieIssue: CookieIssue = "ID_COOKIE_MISSING";
  for (const header of headers) {
    const isIdCookie = /^id_token=/.test(header);
    if (isIdCookie) idCookieHeaderCount += 1;
    const parsed = parseCookie(header, cookieNow);
    if (parsed.cookie) cookies.push(parsed.cookie);
    else if (isIdCookie) idCookieIssue = parsed.issue;
  }
  if (idCookieHeaderCount !== 1 ||
      cookies.filter(cookie => cookie.name === "id_token").length !== 1)
    return { ...failed("COOKIE_UNVERIFIED"), cookieIssue:
      idCookieHeaderCount > 1 ?
        "ID_COOKIE_DUPLICATE" : idCookieHeaderCount === 1 ? idCookieIssue :
          "ID_COOKIE_MISSING" };

  let shopVerified = false;
  const post = async (operationName: string, query: string,
    variables?: Record<string, string>): Promise<GraphqlResult> => {
    const current = clock();
    if (!Number.isSafeInteger(current) || cookies.some(cookie =>
        cookie.expiresAt !== null && cookie.expiresAt <= current)) return null;
    try {
      const result = await fetchPort(GRAPHQL_URL, { method: "POST",
        redirect: "manual", credentials: "omit", cache: "no-store",
        signal: AbortSignal.timeout(10_000),
        headers: { "Content-Type": "application/json", Accept: "application/json",
          Origin: ORIGIN, Cookie: cookies.map(cookie =>
            `${cookie.name}=${cookie.value}`).join("; ") },
        body: JSON.stringify({ operationName, query, ...(variables ?
          { variables } : {}) }) });
      if (result.redirected || result.status >= 300 && result.status < 400)
        return null;
      // Authentication failures often have empty or HTML bodies. Keep their
      // status before attempting GraphQL JSON parsing.
      if (result.status === 401 || result.status === 403)
        return { status: result.status, body: null };
      return { status: result.status, body: await result.json() };
    } catch { return null; }
  };
  const selfResult = await post("Self", SELF_QUERY);
  if (selfResult?.status === 401 || selfResult?.status === 403)
    return failed("AUTH_REQUIRED");
  const self = validGraphql(selfResult);
  if (!self || !object(self.self)) return failed("REMOTE_UNVERIFIED");

  const client: WebHttpReadOnlyClient = {
    verifyTargetShop: async () => {
      shopVerified = false;
      const result = await post("OwnShops", SHOPS_QUERY);
      if (result?.status === 401 || result?.status === 403)
        return { status: "AUTH_REQUIRED", shopMatched: false };
      const data = validGraphql(result);
      if (!data || !Array.isArray(data.ownShops))
        return { status: "REMOTE_UNVERIFIED", shopMatched: false };
      shopVerified = data.ownShops.some(shop =>
        object(shop) && shop.id === WEB_HTTP_SHOP_ID);
      return { status: shopVerified ? "VERIFIED" : "SHOP_MISMATCH",
        shopMatched: shopVerified };
    },
    readKnownB005396Drafts: async () => {
      const result = (status: ReadStatus, correctDraftMatched = false,
        emptyDraftMatched = false) => ({ status, correctDraftMatched,
        emptyDraftMatched });
      if (!shopVerified) return result("SHOP_MISMATCH");
      const ids = [B005396_CORRECT_DRAFT_ID, B005396_EMPTY_DRAFT_ID];
      const matched: boolean[] = [];
      for (const id of ids) {
        const read = await post("GetProductDraft", DRAFT_QUERY, { id });
        if (read?.status === 401 || read?.status === 403)
          return result("AUTH_REQUIRED", matched[0] ?? false);
        const data = validGraphql(read);
        if (!data || !object(data.productDraft) ||
            data.productDraft.id !== id)
          return result("REMOTE_UNVERIFIED", matched[0] ?? false);
        matched.push(true);
      }
      return result("VERIFIED", true, true);
    },
  };
  return { status: "READY", client,
    cookieExpiryKnown: cookies.find(cookie => cookie.name === "id_token")!
      .expiresAt !== null, cookieIssue: null };
}

import "server-only";

import { WEB_HTTP_SHOP_ID } from "./webHttpDraftJob.ts";
import { B005396_CORRECT_DRAFT_ID, B005396_EMPTY_DRAFT_ID } from
  "./webHttpObservedDraftRead.ts";
import type { WebHttpDraftReadback,
  WebHttpDraftCandidate } from "./webHttpDraftSaveReconciliation.ts";
import type { VerifiedCreatedDraftReadback, VerifiedUpdatedDraftReadback } from
  "./webHttpAcknowledgedProofs.ts";

const ORIGIN = "https://mercari-shops.com";
const IDP_URL = `${ORIGIN}/auth/signin/idp`;
const GRAPHQL_URL = `${ORIGIN}/graphql`;
const SELF_QUERY = `query Self { self { accountId } }`;
const SHOPS_QUERY = `query OwnShops { ownShops { id } }`;
const DRAFT_QUERY = `query GetProductDraft($id: String!) {
  productDraft(id: $id) { id }
}`;
// Exact list/detail selections observed in the existing Shops HAR.
const DRAFT_LIST_QUERY = `query productDrafts($shopId: String!, $cursor: String, $first: Int) {
  productDrafts(after: $cursor, first: $first, shopId: $shopId) {
    pageInfo { ...PageInfo __typename }
    edges { node { ...ProductDraftListItem __typename } __typename }
    __typename
  }
}
fragment PageInfo on PageInfo { hasNextPage endCursor __typename }
fragment ProductDraftListItem on ProductDraft {
  id name description price
  shippingPayerType { id name __typename }
  thumbnails { id imageUrl(options: {presets: [Small]}) __typename }
  updatedAt channelListingScope __typename
}`;
const DRAFT_DETAIL_QUERY = `query GetProductDraft($id: String!) {
  productDraft(id: $id) {
    ... on ProductDraft {
      id name description price
      condition { id name __typename }
      brands { id name __typename }
      categories { category { id name mercariCategoryId __typename } __typename }
      thumbnails { id imageUrl(options: {presets: [Large]}) contentType __typename }
      variants {
        name quantity janCode skuCode catalogSkuId
        maxQuantityPerOrderConfig { configuredValue actualValue __typename }
        attributes {
          id title required type flags
          options { id title legacyId __typename }
          inputValue __typename
        }
        __typename
      }
      shippingMethodType { id name __typename }
      shippingPayerType { id name __typename }
      shippingDurationType { id name __typename }
      shippingFromState { id name __typename }
      shippingConfiguration { id __typename }
      mercariBinForBusinessSetting {
        id
        mercaribinForBusinessCoolType { id name __typename }
        mercaribinForBusinessShippingFeeType { id name __typename }
        __typename
      }
      preOrder {
        releaseDate
        acceptancePeriod { from to __typename }
        cancellationDeadline deliveryTiming __typename
      }
      isRefurbished channelListingScope __typename
    }
    countryRestrictionTemplateId __typename
  }
}`;
const MAX_DRAFT_PAGES = 100;
const MAX_DRAFT_IDS = 5_000;
const MAX_DRAFT_CANDIDATES = 10_000;
const DRAFT_ID = /^[A-Za-z0-9]{1,64}$/;

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
  listDraftCandidates: WebHttpDraftReadback["listDraftCandidates"];
  readVerifiedCreatedDraft: VerifiedCreatedDraftReadback;
  readVerifiedUpdatedDraft: VerifiedUpdatedDraftReadback;
  /** Same session, adapted to the reconciliation result vocabulary. */
  reconciliationReadback: WebHttpDraftReadback;
};
export type WebHttpOpenResult = { status: Status;
  client: WebHttpReadOnlyClient | null;
  failureStage: "INPUT" | "IDP_NETWORK" | "IDP_HTTP" |
    "IDP_COOKIE" | "SELF_READ" | null;
  httpStatus: number | null;
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

function authRequired(result: GraphqlResult): boolean {
  if (result?.status === 401 || result?.status === 403) return true;
  if (!result || !object(result.body) || !Array.isArray(result.body.errors))
    return false;
  return result.body.errors.some(error => object(error) &&
    object(error.extensions) &&
    ["UNAUTHENTICATED", "FORBIDDEN"].includes(String(error.extensions.code)));
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
  const failed = (status: Status,
    failureStage: WebHttpOpenResult["failureStage"] = null,
    httpStatus: number | null = null): WebHttpOpenResult =>
    ({ status, client: null, failureStage, httpStatus,
      cookieExpiryKnown: false, cookieIssue: null });
  if (!safeToken(credentials?.idToken) ||
      !safeToken(credentials?.refreshToken)) return failed("AUTH_REQUIRED", "INPUT");
  const fetchPort = options.fetchPort ?? fetch;
  const clock = options.clock ?? Date.now;
  const now = clock();
  if (!Number.isSafeInteger(now) || now < 0)
    return failed("REMOTE_UNVERIFIED", "INPUT");
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
  } catch { return failed("REMOTE_UNVERIFIED", "IDP_NETWORK"); }
  if (response.status === 401 || response.status === 403)
    return failed("AUTH_REQUIRED", "IDP_HTTP", response.status);
  if (response.status !== 200 || response.redirected)
    return failed("REMOTE_UNVERIFIED", "IDP_HTTP", response.status);
  // Never use a combined Set-Cookie string: Expires commas are ambiguous.
  const getSetCookie = (response.headers as Headers & {
    getSetCookie?: () => string[] }).getSetCookie;
  if (typeof getSetCookie !== "function") return { ...failed("COOKIE_UNVERIFIED",
    "IDP_COOKIE", response.status),
    cookieIssue: "HEADER_API_UNAVAILABLE" };
  const headers = getSetCookie.call(response.headers);
  const cookieNow = clock();
  if (!Number.isSafeInteger(cookieNow) || cookieNow < now)
    return failed("COOKIE_UNVERIFIED", "IDP_COOKIE", response.status);
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
    return { ...failed("COOKIE_UNVERIFIED", "IDP_COOKIE",
      response.status), cookieIssue:
      idCookieHeaderCount > 1 ?
        "ID_COOKIE_DUPLICATE" : idCookieHeaderCount === 1 ? idCookieIssue :
          "ID_COOKIE_MISSING" };

  let shopVerified = false;
  const post = async (operationName: string, query: string,
    variables?: Record<string, string | number>): Promise<GraphqlResult> => {
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
      const completed = clock();
      if (!Number.isSafeInteger(completed) || completed < current ||
          cookies.some(cookie => cookie.expiresAt !== null &&
            cookie.expiresAt <= completed) ||
          result.redirected || result.status >= 300 && result.status < 400)
        return null;
      // Authentication failures often have empty or HTML bodies. Keep their
      // status before attempting GraphQL JSON parsing.
      if (result.status === 401 || result.status === 403)
        return { status: result.status, body: null };
      const responseBody: unknown = await result.json();
      const parsed = clock();
      if (!Number.isSafeInteger(parsed) || parsed < completed ||
          cookies.some(cookie => cookie.expiresAt !== null &&
            cookie.expiresAt <= parsed)) return null;
      return { status: result.status, body: responseBody };
    } catch { return null; }
  };
  const selfResult = await post("Self", SELF_QUERY);
  if (authRequired(selfResult))
    return failed("AUTH_REQUIRED", "SELF_READ", selfResult?.status ?? null);
  const self = validGraphql(selfResult);
  if (!self || !object(self.self))
    return failed("REMOTE_UNVERIFIED", "SELF_READ",
      selfResult?.status ?? null);

  const core: Omit<WebHttpReadOnlyClient, "reconciliationReadback"> = {
    verifyTargetShop: async () => {
      shopVerified = false;
      const result = await post("OwnShops", SHOPS_QUERY);
      if (authRequired(result))
        return { status: "AUTH_REQUIRED", shopMatched: false };
      const data = validGraphql(result);
      if (!data || !Array.isArray(data.ownShops))
        return { status: "REMOTE_UNVERIFIED", shopMatched: false };
      shopVerified = data.ownShops.some(shop =>
        object(shop) && shop.id === WEB_HTTP_SHOP_ID);
      return { status: shopVerified ? "VERIFIED" : "SHOP_MISMATCH",
        shopMatched: shopVerified };
    },
    readVerifiedCreatedDraft: async draftId => {
      const unknown = (status: "UNKNOWN" | "AUTH_REQUIRED" = "UNKNOWN") =>
        ({ status, shopId: null, draftId: null, skuCode: null,
          name: null, description: null });
      if (!shopVerified || !DRAFT_ID.test(draftId)) return unknown();
      const read = await post("GetProductDraft", DRAFT_DETAIL_QUERY,
        { id: draftId });
      if (authRequired(read))
        return unknown("AUTH_REQUIRED");
      const data = validGraphql(read);
      if (!data || !object(data.productDraft)) return unknown();
      const draft = data.productDraft;
      if (draft.id !== draftId || typeof draft.name !== "string" ||
          typeof draft.description !== "string" ||
          !Array.isArray(draft.variants) || draft.variants.length !== 1 ||
          !object(draft.variants[0]) ||
          typeof draft.variants[0].skuCode !== "string") return unknown();
      return { status: "VERIFIED" as const, shopId: WEB_HTTP_SHOP_ID,
        draftId, skuCode: draft.variants[0].skuCode,
        name: draft.name, description: draft.description };
    },
    readVerifiedUpdatedDraft: async draftId => {
      const unknown = (status: "UNKNOWN" | "AUTH_REQUIRED" = "UNKNOWN") =>
        ({ status, shopId: null, draftId: null, skuCode: null,
          name: null, description: null, price: null, quantity: null,
          categoryId: null, conditionId: null, imageAssetIds: null,
          shippingMethodId: null, shippingPayerId: null,
          shippingDurationId: null, shippingFromStateId: null });
      if (!shopVerified || !DRAFT_ID.test(draftId)) return unknown();
      const read = await post("GetProductDraft", DRAFT_DETAIL_QUERY,
        { id: draftId });
      if (authRequired(read))
        return unknown("AUTH_REQUIRED");
      const data = validGraphql(read);
      const draft = data?.productDraft;
      if (!object(draft) || draft.id !== draftId ||
          typeof draft.name !== "string" ||
          typeof draft.description !== "string" ||
          typeof draft.price !== "number" ||
          !Array.isArray(draft.variants) || draft.variants.length !== 1 ||
          !object(draft.variants[0]) ||
          typeof draft.variants[0].skuCode !== "string" ||
          typeof draft.variants[0].quantity !== "number" ||
          !Array.isArray(draft.categories) ||
          draft.categories.length !== 1 ||
          !object(draft.categories[0]) ||
          !object(draft.categories[0].category) ||
          typeof draft.categories[0].category.id !== "string" ||
          !Array.isArray(draft.thumbnails) ||
          !draft.thumbnails.every(image => object(image) &&
            typeof image.id === "string") ||
          !object(draft.condition) ||
          typeof draft.condition.id !== "string" ||
          !object(draft.shippingMethodType) ||
          typeof draft.shippingMethodType.id !== "string" ||
          !object(draft.shippingPayerType) ||
          typeof draft.shippingPayerType.id !== "string" ||
          !object(draft.shippingDurationType) ||
          typeof draft.shippingDurationType.id !== "string" ||
          !object(draft.shippingFromState) ||
          typeof draft.shippingFromState.id !== "string") return unknown();
      return { status: "VERIFIED" as const, shopId: WEB_HTTP_SHOP_ID,
        draftId, skuCode: draft.variants[0].skuCode,
        name: draft.name, description: draft.description,
        price: draft.price, quantity: draft.variants[0].quantity,
        categoryId: draft.categories[0].category.id,
        conditionId: draft.condition.id,
        imageAssetIds: draft.thumbnails.map(image => image.id),
        shippingMethodId: draft.shippingMethodType.id,
        shippingPayerId: draft.shippingPayerType.id,
        shippingDurationId: draft.shippingDurationType.id,
        shippingFromStateId: draft.shippingFromState.id };
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
        if (authRequired(read))
          return result("AUTH_REQUIRED", matched[0] ?? false);
        const data = validGraphql(read);
        if (!data || !object(data.productDraft) ||
            data.productDraft.id !== id)
          return result("REMOTE_UNVERIFIED", matched[0] ?? false);
        matched.push(true);
      }
      return result("VERIFIED", true, true);
    },
    listDraftCandidates: async shopId => {
      const unknown = (status: "UNKNOWN" | "AUTH_REQUIRED" = "UNKNOWN") =>
        ({ status, complete: false, candidates: [] as WebHttpDraftCandidate[] });
      if (!shopVerified || shopId !== WEB_HTTP_SHOP_ID)
        return unknown();
      const ids: string[] = [];
      const seenIds = new Set<string>();
      const seenCursors = new Set<string>();
      let cursor: string | null = null;
      let complete = false;
      for (let page = 0; page < MAX_DRAFT_PAGES; page++) {
        const variables: Record<string, string | number> =
          { shopId, first: 50 };
        if (cursor !== null) variables.cursor = cursor;
        const read = await post("productDrafts", DRAFT_LIST_QUERY, variables);
        if (authRequired(read))
          return unknown("AUTH_REQUIRED");
        const data = validGraphql(read);
        const connection = data?.productDrafts;
        if (!object(connection) || !object(connection.pageInfo) ||
            typeof connection.pageInfo.hasNextPage !== "boolean" ||
            typeof connection.pageInfo.endCursor !== "string" ||
            !Array.isArray(connection.edges)) return unknown();
        for (const edge of connection.edges) {
          const node = object(edge) ? edge.node : null;
          if (!object(node) || typeof node.id !== "string" ||
              !DRAFT_ID.test(node.id) || seenIds.has(node.id) ||
              ids.length >= MAX_DRAFT_IDS) return unknown();
          seenIds.add(node.id);
          ids.push(node.id);
        }
        if (!connection.pageInfo.hasNextPage) {
          complete = true;
          break;
        }
        const next = connection.pageInfo.endCursor;
        if (!next || seenCursors.has(next) ||
            connection.edges.length === 0) return unknown();
        seenCursors.add(next);
        cursor = next;
      }
      if (!complete) return unknown();
      const candidates: WebHttpDraftCandidate[] = [];
      for (const id of ids) {
        const read = await post("GetProductDraft", DRAFT_DETAIL_QUERY, { id });
        if (authRequired(read))
          return unknown("AUTH_REQUIRED");
        const data = validGraphql(read);
        const draft = data?.productDraft;
        if (!object(draft) || draft.id !== id ||
            typeof draft.name !== "string" ||
            typeof draft.description !== "string" ||
            !Number.isSafeInteger(draft.price) ||
            (draft.price as number) < 0 ||
            !Array.isArray(draft.thumbnails) ||
            !draft.thumbnails.every(thumbnail => object(thumbnail) &&
              typeof thumbnail.id === "string" && thumbnail.id.length > 0) ||
            !Array.isArray(draft.variants)) return unknown();
        for (const variant of draft.variants) {
          if (!object(variant) || typeof variant.skuCode !== "string" ||
              !Number.isSafeInteger(variant.quantity) ||
              (variant.quantity as number) < 0 ||
              candidates.length >= MAX_DRAFT_CANDIDATES) return unknown();
          candidates.push({ id, shopId, name: draft.name,
            description: draft.description, price: draft.price as number,
            quantity: variant.quantity as number,
            skuCode: variant.skuCode,
            thumbnailCount: draft.thumbnails.length });
        }
      }
      return { status: "OK", complete: true, candidates };
    },
  };
  const reconciliationReadback: WebHttpDraftReadback = {
    verifyTargetShop: async () => {
      const shop = await core.verifyTargetShop();
      return { status: shop.status === "VERIFIED" ? "VERIFIED" :
        shop.status === "AUTH_REQUIRED" ? "AUTH_REQUIRED" : "UNKNOWN",
      shopMatched: shop.shopMatched };
    },
    listDraftCandidates: core.listDraftCandidates,
  };
  return { status: "READY", client: { ...core, reconciliationReadback },
    failureStage: null, httpStatus: null,
    cookieExpiryKnown: cookies.find(cookie => cookie.name === "id_token")!
      .expiresAt !== null, cookieIssue: null };
}

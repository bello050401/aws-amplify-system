import "server-only";

import { openMercariWebHttpCookieReadOnly } from "./webHttpReadOnlyClient.ts";

type Session = { cookieHeader: string; expiresAtMs: number | null };
type RequestEvidence = {
  operation: string; httpStatus: number; challengeDetected: boolean; html: boolean;
};
export type WebHttpReadProbeResult = {
  status: "INVALID_INPUT" | "AUTH_REQUIRED" | "READ_UNVERIFIED" |
    "SHOP_MISMATCH" | "REMOTE_CHALLENGE" | "HTTPS_READ_VERIFIED";
  stage: "INPUT" | "SELF" | "SHOP" | "PRODUCT";
  requests: RequestEvidence[];
  shopMatched: boolean;
  productVerified: boolean;
  productId: string | null;
  remoteStatus: "STATUS_OPENED" | "STATUS_UNOPENED" | null;
  priceYen: number | null;
  quantity: number | null;
  imageCount: number | null;
};

/** Read-only diagnostic shared by a local probe and the cloud probe.
 * Only fixed, already observed queries can leave this boundary. Never returns
 * the session, raw responses, product text, headers or exception messages.
 */
export async function probeMercariWebHttpProductRead(session: Session,
  productId: string, options: { fetchPort?: typeof fetch; clock?: () => number } = {},
): Promise<WebHttpReadProbeResult> {
  const result: WebHttpReadProbeResult = { status: "INVALID_INPUT", stage: "INPUT",
    requests: [], shopMatched: false, productVerified: false, productId: null,
    remoteStatus: null, priceYen: null, quantity: null, imageCount: null };
  if (!/^[A-Za-z0-9]{1,64}$/.test(productId)) return result;
  const allowed = new Set(["Self", "OwnShops", "EditProductPage"]);
  const fetchPort: typeof fetch = async (url, init) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    if (url !== "https://mercari-shops.com/graphql" || init?.method !== "POST" ||
        init.redirect !== "manual" || !allowed.has(body?.operationName) ||
        typeof body.query !== "string" || !/^query\s/.test(body.query.trim()))
      throw Error("READ_ONLY_BOUNDARY");
    const response = await (options.fetchPort ?? fetch)(url, init);
    result.requests.push({ operation: body.operationName, httpStatus: response.status,
      challengeDetected: response.headers.get("cf-mitigated") === "challenge",
      html: /text\/html/i.test(response.headers.get("content-type") ?? "") });
    return response;
  };
  const failure = (authRequired: boolean) => {
    result.status = result.requests.some(row => row.challengeDetected) ?
      "REMOTE_CHALLENGE" : authRequired ? "AUTH_REQUIRED" : "READ_UNVERIFIED";
    return result;
  };
  try {
    result.stage = "SELF";
    const opened = await openMercariWebHttpCookieReadOnly(session,
      { fetchPort, clock: options.clock });
    if (!opened.client) return failure(opened.status === "AUTH_REQUIRED");
    result.stage = "SHOP";
    const shop = await opened.client.verifyTargetShop();
    if (!shop.shopMatched) {
      if (shop.status === "SHOP_MISMATCH") {
        result.status = "SHOP_MISMATCH";
        return result;
      }
      return failure(shop.status === "AUTH_REQUIRED");
    }
    result.shopMatched = true;
    result.stage = "PRODUCT";
    const read = await opened.client.readProduct(productId);
    if (!read.product) return failure(read.status === "AUTH_REQUIRED");
    result.status = "HTTPS_READ_VERIFIED";
    result.productVerified = true;
    result.productId = read.product.id;
    result.remoteStatus = read.product.status;
    result.priceYen = read.product.fields.price;
    result.quantity = read.product.variants[0].quantity;
    result.imageCount = read.product.fields.assetIds.length;
    return result;
  } catch { return failure(false); }
}

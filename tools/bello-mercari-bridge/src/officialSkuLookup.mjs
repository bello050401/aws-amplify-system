// Read-only request specification from Mercari Shops' published GraphQL schema.
// This module contains no HTTP client, credential input, or product mutation.
const SKU = /^[A-Za-z0-9_-]{1,50}$/;
const ID = /^[A-Za-z0-9_-]{1,100}$/;
const MAX_CURSOR = 512;
const validSku = value => typeof value === "string" && SKU.test(value);
const validId = value => typeof value === "string" && ID.test(value);
export const OFFICIAL_API_ENDPOINT = "https://api.mercari-shops.com/v1/graphql";
export const PRODUCTS_BY_SKU_QUERY = `query BelloProductsBySku($keyword: String!, $after: String, $first: Int) {
  products(keyword: $keyword, after: $after, first: $first) {
    edges { node { id variants { skuCode } } }
    pageInfo { endCursor hasNextPage }
  }
}`;

function validCursor(value) {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_CURSOR &&
    !/[\u0000-\u001f\u007f]/.test(value);
}

export function buildOfficialSkuLookupPage(skuCode, after = null) {
  if (!validSku(skuCode) || after !== null && !validCursor(after))
    throw Error("Invalid exact SKU lookup target");
  return { endpoint: OFFICIAL_API_ENDPOINT, method: "POST",
    operationName: "BelloProductsBySku", query: PRODUCTS_BY_SKU_QUERY,
    variables: { keyword: skuCode, after, first: 100 } };
}

/** Classify one page; an empty last page alone does not prove a complete scan. */
export function inspectOfficialSkuLookupPage(body, skuCode, seenCursors = []) {
  const unverified = { status: "UNVERIFIED", productId: null, nextCursor: null };
  if (!validSku(skuCode) || !Array.isArray(seenCursors) ||
      seenCursors.some(cursor => !validCursor(cursor)) ||
      !body || typeof body !== "object" || Array.isArray(body) ||
      body.errors !== undefined && (!Array.isArray(body.errors) || body.errors.length))
    return unverified;
  const connection = body.data?.products;
  const edges = connection?.edges;
  const pageInfo = connection?.pageInfo;
  if (!Array.isArray(edges) || edges.length > 100 ||
      !pageInfo || typeof pageInfo.hasNextPage !== "boolean") return unverified;
  let foundId = null;
  for (const edge of edges) {
    const product = edge?.node;
    if (!product || !validId(product.id) || !Array.isArray(product.variants))
      return unverified;
    for (const variant of product.variants) {
      if (!variant || variant.skuCode !== null &&
          !validSku(variant.skuCode))
        return unverified;
      if (variant.skuCode === skuCode) {
        if (foundId && foundId !== product.id) return unverified;
        foundId = product.id;
      }
    }
  }
  if (foundId) return { status: "FOUND", productId: foundId, nextCursor: null };
  if (!pageInfo.hasNextPage)
    return { status: "FINAL_PAGE_NO_MATCH", productId: null, nextCursor: null };
  if (!validCursor(pageInfo.endCursor) || seenCursors.includes(pageInfo.endCursor))
    return unverified;
  return { status: "NEXT_PAGE", productId: null, nextCursor: pageInfo.endCursor };
}

/** Only a contiguous scan starting at null may establish SKU absence. */
export function scanOfficialSkuLookupPages(pages, skuCode) {
  const unverified = { status: "UNVERIFIED", productId: null, nextCursor: null };
  if (!Array.isArray(pages) || pages.length === 0 || pages.length > 50 || !validSku(skuCode))
    return unverified;
  let expectedAfter = null;
  const seenCursors = [];
  for (const [index, page] of pages.entries()) {
    if (!page || page.requestedAfter !== expectedAfter) return unverified;
    const result = inspectOfficialSkuLookupPage(page.body, skuCode, seenCursors);
    if (result.status === "FOUND") return index === pages.length - 1 ? result : unverified;
    if (result.status === "FINAL_PAGE_NO_MATCH")
      return index === pages.length - 1 ?
        { status: "ABSENT_ON_COMPLETE_SCAN", productId: null, nextCursor: null } : unverified;
    if (result.status === "UNVERIFIED") return unverified;
    seenCursors.push(result.nextCursor);
    expectedAfter = result.nextCursor;
  }
  return { status: "INCOMPLETE", productId: null, nextCursor: expectedAfter };
}

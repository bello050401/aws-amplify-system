import { createHash } from "node:crypto";
import { isExplicitDraftReadQueryRequest } from
  "./draftReadMetadataObserver.mjs";

const ORIGIN = "https://mercari-shops.com";
const GRAPHQL = `${ORIGIN}/graphql`;
const ID = /^[A-Za-z0-9_-]{1,100}$/;
const LIST_SHA =
  "035b93384798e16e4a71bfdab8fa0e95bc0db9ae1a602e7ce832e016cebc147e";
const DETAIL_SHA =
  "f6a841578f2199faec359e918c169f2ecbbdf0ceaa71fbe439588016c598d5b0";
const MAX_BODY_BYTES = 512 * 1024;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const keys = (value, names) => value && typeof value === "object" &&
  !Array.isArray(value) && same(Object.keys(value).sort(), names.slice().sort());
const titleKey = value => value.normalize("NFKC").replace(/\s+/g, "").trim();
const fixed = diagnostic => ({ status: "DRAFT_NETWORK_BOUND_UNVERIFIED",
  diagnostic, complete: false, allowFinalCreate: false });

function requestKind(request, page, shopId) {
  if (!isExplicitDraftReadQueryRequest(request) ||
      request.url() !== GRAPHQL) return null;
  try { if (request.frame().page() !== page) return null; }
  catch { return null; }
  const bytes = request.postDataBuffer?.();
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX_BODY_BYTES) return null;
  let body;
  try { body = JSON.parse(bytes.toString("utf8")); } catch { return null; }
  const sha = createHash("sha256").update(body.query).digest("hex");
  const url = new URL(page.url());
  if (url.origin !== ORIGIN) return null;
  if (body.operationName === "productDrafts" && sha === LIST_SHA &&
      url.pathname === `/seller/shops/${shopId}/products` &&
      url.search === "?tab=draft" &&
      keys(body.variables, ["shopId", "first"]) &&
      body.variables.shopId === shopId && body.variables.first === 50)
    return { kind: "LIST" };
  if (body.operationName === "GetProductDraft" && sha === DETAIL_SHA &&
      url.pathname === `/seller/shops/${shopId}/products/create` &&
      [...url.searchParams.keys()].join() === "productDraftId" &&
      keys(body.variables, ["id"]) && ID.test(body.variables.id ?? "") &&
      url.searchParams.get("productDraftId") === body.variables.id)
    return { kind: "DETAIL", id: body.variables.id };
  return null;
}

function readList(body, expectedRowCount) {
  const result = body?.data?.productDrafts;
  if (body?.errors !== undefined || !result ||
      result.pageInfo?.hasNextPage !== false ||
      !Array.isArray(result.edges) ||
      result.edges.length !== expectedRowCount) return null;
  const rows = result.edges.map(edge => {
    const node = edge?.node;
    return { id: node?.id, title: node?.name, price: node?.price };
  });
  if (rows.some(row => !ID.test(row.id ?? "") ||
      typeof row.title !== "string" || row.title.length > 130 ||
      !Number.isSafeInteger(row.price) || row.price < 0) ||
      new Set(rows.map(row => row.id)).size !== expectedRowCount)
    return null;
  return rows;
}

function readDetail(body, id) {
  const item = body?.data?.productDraft;
  const variant = item?.variants?.[0];
  if (body?.errors !== undefined || item?.id !== id ||
      typeof item.name !== "string" || item.name.length > 130 ||
      typeof item.description !== "string" ||
      !Number.isSafeInteger(item.price) || item.price < 0 ||
      !Array.isArray(item.thumbnails) ||
      !Array.isArray(item.variants) || item.variants.length !== 1 ||
      !variant || (variant.skuCode !== null &&
        (typeof variant.skuCode !== "string" ||
          variant.skuCode.length > 100 ||
          variant.skuCode && !ID.test(variant.skuCode))) ||
      !Number.isSafeInteger(variant.quantity) || variant.quantity < 0)
    return null;
  return { id, title: item.name, skuCode: variant.skuCode || null,
    priceYen: item.price, imageCount: item.thumbnails.length };
}

/** The result remains advisory: even a complete proof never enables a send. */
export function evaluateBoundDraftReadProof({ list, details, failed, rows,
  managementCode, title, priceYen, expectedRowCount }) {
  if (failed || !Array.isArray(list) || !(details instanceof Map) ||
      !Array.isArray(rows) || rows.length !== expectedRowCount ||
      list.length !== expectedRowCount ||
      !ID.test(managementCode ?? "") ||
      typeof title !== "string" || !title.trim() ||
      !Number.isSafeInteger(priceYen) || priceYen < 1)
    return fixed("READ_OR_INPUT_UNVERIFIED");
  const listed = new Map(list.map(row => [row.id, row]));
  if (listed.size !== expectedRowCount)
    return fixed("ROW_SET_UNVERIFIED");
  const seen = new Set();
  let anonymous = 0;
  for (const row of rows) {
    const id = row?.draftId;
    const detail = details.get(id);
    const listedRow = listed.get(id);
    if (!ID.test(id ?? "") || seen.has(id) || !detail || !listedRow ||
        detail.id !== id || typeof detail.title !== "string" ||
        (detail.skuCode !== null && typeof detail.skuCode !== "string") ||
        !Number.isSafeInteger(detail.priceYen) || detail.priceYen < 0 ||
        !Number.isSafeInteger(detail.imageCount) || detail.imageCount < 0 ||
        typeof listedRow.title !== "string" ||
        typeof row.title !== "string" ||
        titleKey(row.title) !== titleKey(detail.title) ||
        titleKey(listedRow.title) !== titleKey(detail.title) ||
        (row.skuCode || null) !== detail.skuCode ||
        listedRow.price !== detail.priceYen)
      return fixed("ROW_RESPONSE_BINDING_UNVERIFIED");
    seen.add(id);
    if (detail.skuCode?.toUpperCase() === managementCode.toUpperCase() ||
        detail.title && titleKey(detail.title) === titleKey(title))
      return { status: "REMOTE_DUPLICATE_POSSIBLE", complete: false,
        allowFinalCreate: false };
    if (!detail.title) {
      // A blank draft is only distinct from the prepared product when its
      // remote response has no management code, price, or image.
      if (detail.skuCode !== null || detail.priceYen !== 0 ||
          detail.imageCount !== 0)
        return fixed("ANONYMOUS_DRAFT_UNVERIFIED");
      anonymous++;
    }
  }
  if (seen.size !== listed.size || seen.size !== details.size)
    return fixed("ROW_SET_UNVERIFIED");
  return { status: "DRAFT_NETWORK_BOUND_NO_MATCH", complete: true,
    allowFinalCreate: false, rowCount: seen.size,
    anonymousVerified: anonymous };
}

/** Passive proof of the observed Shops list/detail read contract. Raw bodies stay in memory. */
export function observeBoundDraftReads(context, { page, shopId,
  expectedRowCount = 12 } = {}) {
  if (!context || typeof context.on !== "function" ||
      typeof context.off !== "function" || !page ||
      !ID.test(shopId ?? "") || !Number.isSafeInteger(expectedRowCount) ||
      expectedRowCount < 1 || expectedRowCount > 50)
    throw Error("DRAFT_BOUND_READ_INPUT_UNVERIFIED");
  const requests = new WeakMap();
  const pending = new Set();
  let list = null;
  const details = new Map();
  let failed = false;
  let stopped = false;
  const onRequest = request => {
    if (stopped) return;
    const info = requestKind(request, page, shopId);
    if (info) requests.set(request, info);
  };
  const onResponse = response => {
    if (stopped) return;
    const info = requests.get(response.request());
    if (!info) return;
    const work = (async () => {
      try {
        if (response.status() !== 200) { failed = true; return; }
        const bytes = await response.body();
        if (!Buffer.isBuffer(bytes) || bytes.length > MAX_BODY_BYTES) {
          failed = true; return;
        }
        const body = JSON.parse(bytes.toString("utf8"));
        if (info.kind === "LIST") {
          const next = readList(body, expectedRowCount);
          if (!next || list && !same(list, next)) failed = true;
          else list = next;
        } else {
          const next = readDetail(body, info.id);
          if (!next || details.has(info.id) &&
              !same(details.get(info.id), next)) failed = true;
          else details.set(info.id, next);
        }
      } catch { failed = true; }
    })();
    pending.add(work);
    work.finally(() => pending.delete(work));
  };
  context.on("request", onRequest);
  context.on("response", onResponse);
  return { async stop(rows, { managementCode, title, priceYen } = {}) {
    stopped = true;
    context.off("request", onRequest);
    context.off("response", onResponse);
    await Promise.allSettled([...pending]);
    return evaluateBoundDraftReadProof({ list, details, failed, rows,
      managementCode, title, priceYen, expectedRowCount });
  } };
}

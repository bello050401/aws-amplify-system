import { createHash } from "node:crypto";
import { isExplicitDraftReadQueryRequest } from
  "./draftReadMetadataObserver.mjs";

const ORIGIN = "https://mercari-shops.com";
const GRAPHQL = `${ORIGIN}/graphql`;
const ID = /^[A-Za-z0-9_-]{1,100}$/;
const SHA = /^[a-f0-9]{64}$/;
const LIST_SHA =
  "035b93384798e16e4a71bfdab8fa0e95bc0db9ae1a602e7ce832e016cebc147e";
const DETAIL_SHA =
  "f6a841578f2199faec359e918c169f2ecbbdf0ceaa71fbe439588016c598d5b0";
const MAX_BODY_BYTES = 512 * 1024;
const BODY_TIMEOUT_MS = 10_000;
const CYCLE_TIMEOUT_MS = 12_000;
const LIST_FIELDS = ["id", "name", "description", "price",
  "shippingPayerType", "thumbnails", "updatedAt",
  "channelListingScope", "__typename"];
const DETAIL_FIELDS = ["id", "name", "description", "price", "condition",
  "brands", "categories", "thumbnails", "variants", "shippingMethodType",
  "shippingPayerType", "shippingDurationType", "shippingFromState",
  "shippingConfiguration", "mercariBinForBusinessSetting", "preOrder",
  "isRefurbished", "channelListingScope", "__typename",
  "countryRestrictionTemplateId"];
const VARIANT_FIELDS = ["name", "quantity", "janCode", "skuCode",
  "catalogSkuId", "maxQuantityPerOrderConfig", "attributes", "__typename"];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const keys = (value, names) => value && typeof value === "object" &&
  !Array.isArray(value) && same(Object.keys(value).sort(), names.slice().sort());
const titleKey = value => value.normalize("NFKC").replace(/\s+/g, "").trim();
const fingerprint = (node, item) => createHash("sha256")
  .update(JSON.stringify({ node, item })).digest("hex");
const fixed = diagnostic => ({ status: "DRAFT_NETWORK_BOUND_UNVERIFIED",
  diagnostic, complete: false, allowFinalCreate: false });
async function boundedResponseBody(response) {
  let timer;
  try { return await Promise.race([response.body(), new Promise((_, reject) => {
    timer = setTimeout(() => reject(Error("DRAFT_RESPONSE_TIMEOUT")),
      BODY_TIMEOUT_MS);
  })]); }
  finally { clearTimeout(timer); }
}

export function exactCompletedReadCycles(cycles) {
  return Array.isArray(cycles) && cycles.length > 0 && cycles.every(cycle =>
    cycle?.complete === true && ["LIST", "DETAIL"].includes(cycle.kind) &&
    Array.isArray(cycle.requests) && cycle.requests.length > 0 &&
    cycle.requests.every(record => record?.state === "SUCCESS"));
}

export function exactDraftBaseline(value, shopId, expectedRowCount = 12) {
  return value?.schemaVersion === 1 &&
    value.kind === "B005396_DRAFT_BASELINE" &&
    value.shopId === shopId && ID.test(shopId ?? "") &&
    Number.isSafeInteger(expectedRowCount) && expectedRowCount > 0 &&
    value.rowCount === expectedRowCount &&
    Number.isFinite(Date.parse(value.observedAt ?? "")) &&
    Array.isArray(value.rows) && value.rows.length === expectedRowCount &&
    value.rows.every((row, index) => ID.test(row?.draftId ?? "") &&
      SHA.test(row?.fingerprint ?? "") &&
      (index === 0 || value.rows[index - 1].draftId < row.draftId));
}

/** Pinned query plus the visible shop/draft URL must name the same read. */
export function classifyBoundDraftReadTarget({ operationName, querySha256,
  variables, pageUrl, shopId } = {}) {
  let url;
  try { url = new URL(pageUrl); } catch { return null; }
  if (url.origin !== ORIGIN || !ID.test(shopId ?? "")) return null;
  if (operationName === "productDrafts" && querySha256 === LIST_SHA &&
      url.pathname === `/seller/shops/${shopId}/products` &&
      url.search === "?tab=draft" &&
      keys(variables, ["shopId", "first"]) &&
      variables.shopId === shopId && variables.first === 50)
    return { kind: "LIST" };
  if (operationName === "GetProductDraft" && querySha256 === DETAIL_SHA &&
      url.pathname === `/seller/shops/${shopId}/products/create` &&
      [...url.searchParams.keys()].join() === "productDraftId" &&
      keys(variables, ["id"]) && ID.test(variables.id ?? "") &&
      url.searchParams.get("productDraftId") === variables.id)
    return { kind: "DETAIL", id: variables.id };
  return null;
}

function requestKind(request, page, shopId) {
  if (!isExplicitDraftReadQueryRequest(request) ||
      request.url() !== GRAPHQL) return null;
  try { if (request.frame().page() !== page) return null; }
  catch { return null; }
  const bytes = request.postDataBuffer?.();
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX_BODY_BYTES) return null;
  let body;
  try { body = JSON.parse(bytes.toString("utf8")); } catch { return null; }
  return classifyBoundDraftReadTarget({ operationName: body.operationName,
    querySha256: createHash("sha256").update(body.query).digest("hex"),
    variables: body.variables, pageUrl: page.url(), shopId });
}

function readList(body, expectedRowCount) {
  const result = body?.data?.productDrafts;
  if (body?.errors !== undefined || !result ||
      result.pageInfo?.hasNextPage !== false ||
      !Array.isArray(result.edges) ||
      result.edges.length !== expectedRowCount) return null;
  const rows = result.edges.map(edge => {
    const node = edge?.node;
    return { id: node?.id, title: node?.name, price: node?.price,
      node };
  });
  if (rows.some(row => !keys(row.node, LIST_FIELDS) ||
      !ID.test(row.id ?? "") ||
      typeof row.title !== "string" || row.title.length > 130 ||
      typeof row.node.description !== "string" ||
      !Array.isArray(row.node.thumbnails) ||
      !Number.isSafeInteger(row.node.updatedAt) ||
      row.node.updatedAt <= 0 ||
      typeof row.node.channelListingScope !== "string" ||
      typeof row.node.shippingPayerType?.id !== "string" ||
      !Number.isSafeInteger(row.price) || row.price < 0) ||
      new Set(rows.map(row => row.id)).size !== expectedRowCount)
    return null;
  return rows;
}

function readDetail(body, id) {
  const item = body?.data?.productDraft;
  const variant = item?.variants?.[0];
  if (body?.errors !== undefined || item?.id !== id ||
      !keys(item, DETAIL_FIELDS) || !keys(variant, VARIANT_FIELDS) ||
      typeof item.name !== "string" || item.name.length > 130 ||
      typeof item.description !== "string" ||
      !Number.isSafeInteger(item.price) || item.price < 0 ||
      !Array.isArray(item.brands) || !Array.isArray(item.categories) ||
      !Array.isArray(item.thumbnails) ||
      !Array.isArray(item.variants) || item.variants.length !== 1 ||
      typeof item.isRefurbished !== "boolean" ||
      typeof item.channelListingScope !== "string" ||
      typeof item.countryRestrictionTemplateId !== "string" ||
      !variant || (variant.skuCode !== null &&
        (typeof variant.skuCode !== "string" ||
          variant.skuCode.length > 100 ||
          variant.skuCode && !ID.test(variant.skuCode))) ||
      !Number.isSafeInteger(variant.quantity) || variant.quantity < 0 ||
      typeof variant.name !== "string" ||
      typeof variant.janCode !== "string" ||
      !Array.isArray(variant.attributes))
    return null;
  return { id, title: item.name, skuCode: variant.skuCode || null,
    priceYen: item.price, imageCount: item.thumbnails.length, item };
}

function exactAnonymous(item) {
  const variant = item.variants[0];
  return item.name === "" && item.description === "" && item.price === 0 &&
    item.brands.length === 0 && item.categories.length === 0 &&
    item.thumbnails.length === 0 && same(item.condition, {
      id: "CONDITION_UNSPECIFIED", name: "不明",
      __typename: "ProductCondition" }) &&
    same(item.shippingMethodType, { id: "METHOD_TYPE_UNSPECIFIED",
      name: "不明", __typename: "ShippingMethodType" }) &&
    same(item.shippingPayerType, { id: "PAYER_TYPE_SELLER",
      name: "送料込み(出品者負担)", __typename: "ShippingPayerType" }) &&
    same(item.shippingDurationType, { id: "DURATION_TYPE_UNSPECIFIED",
      name: "不明", __typename: "ShippingDurationType" }) &&
    item.shippingFromState === null &&
    item.shippingConfiguration === null &&
    item.mercariBinForBusinessSetting === null && item.preOrder === null &&
    item.isRefurbished === false && item.channelListingScope ===
      "CHANNEL_LISTING_SCOPE_ALL_CHANNELS" &&
    item.countryRestrictionTemplateId === "" && variant.name === "" &&
    variant.quantity === 1 && variant.janCode === "" &&
    !variant.skuCode && variant.catalogSkuId === null &&
    variant.maxQuantityPerOrderConfig === null &&
    variant.attributes.length === 0;
}

function exactOwn(item, reviewed, managementCode, title, priceYen) {
  const variant = item.variants[0];
  return reviewed && typeof reviewed.description === "string" &&
    ID.test(reviewed.categoryId ?? "") &&
    reviewed.quantity === 1 && reviewed.imageCount === 1 &&
    reviewed.condition === "NO_NOTABLE_DAMAGE" &&
    reviewed.shipping?.method === "METHOD_TYPE_UNDECIDED" &&
    reviewed.shipping.payer === "PAYER_TYPE_SELLER" &&
    reviewed.shipping.origin === "jp11" &&
    reviewed.shipping.duration === "DURATION_TYPE_FOUR_TO_SEVEN_DAYS" &&
    titleKey(item.name) === titleKey(title) &&
    item.description === reviewed.description && item.price === priceYen &&
    item.condition?.id === reviewed.condition && item.brands.length === 0 &&
    item.categories.some(category => category?.id === reviewed.categoryId) &&
    item.thumbnails.length === reviewed.imageCount &&
    variant.quantity === reviewed.quantity &&
    variant.skuCode?.toUpperCase() === managementCode.toUpperCase() &&
    item.shippingMethodType?.id === reviewed.shipping.method &&
    item.shippingPayerType?.id === reviewed.shipping.payer &&
    item.shippingFromState?.id === reviewed.shipping.origin &&
    item.shippingDurationType?.id === reviewed.shipping.duration;
}

/** The result remains advisory: even a complete proof never enables a send. */
export function evaluateBoundDraftReadProof({ list, details, failed, rows,
  managementCode, title, priceYen, expectedRowCount, ownDraftId = null,
  reviewed = null, listReadCount = 0, detailReadCounts = new Map(),
  shopId = null, baseline = null }) {
  if (failed) return fixed("READ_RESPONSE_CHANGED_OR_INVALID");
  if (!Array.isArray(list)) return fixed("LIST_RESPONSE_MISSING");
  if (listReadCount < 2) return fixed("LIST_FRESH_READ_MISSING");
  if (!(details instanceof Map) || !(detailReadCounts instanceof Map) ||
      !Array.isArray(rows) || rows.length !== expectedRowCount ||
      list.length !== expectedRowCount ||
      !ID.test(managementCode ?? "") ||
      !ID.test(shopId ?? "") ||
      (ownDraftId !== null && !ID.test(ownDraftId)) ||
      typeof title !== "string" || !title.trim() ||
      !Number.isSafeInteger(priceYen) || priceYen < 1)
    return fixed("READ_OR_INPUT_UNVERIFIED");
  if (ownDraftId !== null &&
      (!exactDraftBaseline(baseline, shopId, baseline?.rowCount) ||
        expectedRowCount !== baseline.rowCount + 1))
    return fixed("DRAFT_BASELINE_UNVERIFIED");
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
        (detailReadCounts.get(id) ?? 0) < 2 ||
        detail.id !== id || !detail.item ||
        typeof detail.title !== "string" ||
        (detail.skuCode !== null && typeof detail.skuCode !== "string") ||
        !Number.isSafeInteger(detail.priceYen) || detail.priceYen < 0 ||
        !Number.isSafeInteger(detail.imageCount) || detail.imageCount < 0 ||
        typeof listedRow.title !== "string" ||
        typeof row.title !== "string" ||
        titleKey(row.title) !== titleKey(detail.title) ||
        titleKey(listedRow.title) !== titleKey(detail.title) ||
        (row.skuCode || null) !== detail.skuCode ||
        listedRow.price !== detail.priceYen ||
        listedRow.node?.description !== detail.item?.description ||
        listedRow.node?.shippingPayerType?.id !==
          detail.item?.shippingPayerType?.id ||
        listedRow.node?.channelListingScope !==
          detail.item?.channelListingScope ||
        listedRow.node?.thumbnails?.length !== detail.imageCount)
      return fixed("ROW_RESPONSE_BINDING_UNVERIFIED");
    seen.add(id);
    if (id === ownDraftId) {
      if (!exactOwn(detail.item, reviewed, managementCode, title, priceYen))
        return fixed("OWN_DRAFT_RESPONSE_UNVERIFIED");
      continue;
    }
    if (detail.skuCode?.toUpperCase() === managementCode.toUpperCase() ||
        detail.title && titleKey(detail.title) === titleKey(title))
      return { status: "REMOTE_DUPLICATE_POSSIBLE", complete: false,
        allowFinalCreate: false };
    if (!titleKey(detail.title)) {
      // A blank draft is only distinct from the prepared product when its
      // remote response has no management code, price, or image.
      if (!exactAnonymous(detail.item))
        return fixed("ANONYMOUS_DRAFT_UNVERIFIED");
      anonymous++;
    }
  }
  if (seen.size !== listed.size || seen.size !== details.size)
    return fixed("ROW_SET_UNVERIFIED");
  if (ownDraftId !== null && !seen.has(ownDraftId))
    return fixed("OWN_DRAFT_RESPONSE_UNVERIFIED");
  const snapshotRows = [...seen].map(id => ({ draftId: id,
    fingerprint: fingerprint(listed.get(id).node, details.get(id).item) }))
    .sort((a, b) => a.draftId < b.draftId ? -1 :
      a.draftId > b.draftId ? 1 : 0);
  if (ownDraftId !== null) {
    const prior = new Map(baseline.rows.map(row =>
      [row.draftId, row.fingerprint]));
    if (snapshotRows.some(row => row.draftId !== ownDraftId &&
        prior.get(row.draftId) !== row.fingerprint) ||
        snapshotRows.filter(row => row.draftId !== ownDraftId).length !==
          baseline.rowCount)
      return fixed("DRAFT_BASELINE_CHANGED");
  }
  return { status: ownDraftId === null ? "DRAFT_NETWORK_BOUND_NO_MATCH" :
    "DRAFT_NETWORK_BOUND_NO_OTHER_MATCH", complete: true,
      allowFinalCreate: false, rowCount: seen.size,
      anonymousVerified: anonymous,
      ...(ownDraftId === null ? { baseline: {
        schemaVersion: 1, kind: "B005396_DRAFT_BASELINE",
        shopId, rowCount: seen.size, rows: snapshotRows,
        observedAt: new Date().toISOString() } } : {}) };
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
  const cycles = [];
  let active = null;
  let list = null;
  let listReadCount = 0;
  const details = new Map();
  const detailReadCounts = new Map();
  let failed = false;
  let stopped = false;
  const onRequest = request => {
    if (stopped) return;
    const info = requestKind(request, page, shopId);
    if (!info) return;
    if (!active || active.kind !== info.kind) { failed = true; return; }
    const record = { info, cycle: active, state: "PENDING" };
    active.requests.push(record);
    requests.set(request, record);
  };
  const onResponse = response => {
    if (stopped) return;
    const record = requests.get(response.request());
    if (!record) return;
    const info = record.info;
    const work = (async () => {
      try {
        if (response.status() !== 200) { failed = true;
          record.state = "FAILED"; return; }
        const bytes = await boundedResponseBody(response);
        if (!Buffer.isBuffer(bytes) || bytes.length > MAX_BODY_BYTES) {
          failed = true; record.state = "FAILED"; return;
        }
        const body = JSON.parse(bytes.toString("utf8"));
        if (info.kind === "LIST") {
          const next = readList(body, expectedRowCount);
          if (!next || list && !same(list, next)) failed = true;
          else { list = next; listReadCount++; }
        } else {
          const next = readDetail(body, info.id);
          if (!next || details.has(info.id) &&
              !same(details.get(info.id), next)) failed = true;
          else { details.set(info.id, next);
            detailReadCounts.set(info.id,
              (detailReadCounts.get(info.id) ?? 0) + 1); }
        }
        record.state = failed ? "FAILED" : "SUCCESS";
      } catch { failed = true; record.state = "FAILED"; }
    })();
    pending.add(work);
    work.finally(() => pending.delete(work));
  };
  const onRequestFailed = request => {
    const record = requests.get(request);
    if (record) { record.state = "FAILED"; failed = true; }
  };
  context.on("request", onRequest);
  context.on("response", onResponse);
  context.on("requestfailed", onRequestFailed);
  return {
    begin(kind) {
      if (stopped || active || !["LIST", "DETAIL"].includes(kind))
        throw Error("DRAFT_READ_CYCLE_UNVERIFIED");
      active = { kind, requests: [], complete: false };
      cycles.push(active);
      return active;
    },
    async end(cycle, draftId = null) {
      if (stopped || cycle !== active ||
          cycle.kind === "DETAIL" && !ID.test(draftId ?? ""))
        throw Error("DRAFT_READ_CYCLE_UNVERIFIED");
      if (cycle.requests.length === 0) { failed = true;
        throw Error("DRAFT_READ_REQUEST_MISSING"); }
      const deadline = Date.now() + CYCLE_TIMEOUT_MS;
      while (cycle.requests.some(record => record.state === "PENDING") &&
          Date.now() < deadline)
        await new Promise(resolve => setTimeout(resolve, 100));
      if (failed || cycle.requests.some(record => record.state !== "SUCCESS" ||
          cycle.kind === "DETAIL" && record.info.id !== draftId)) {
        failed = true; throw Error("DRAFT_READ_RESPONSE_UNVERIFIED");
      }
      cycle.complete = true;
      active = null;
    },
    async stop(rows, { managementCode, title, priceYen,
    ownDraftId = null, reviewed = null, baseline = null } = {}) {
    stopped = true;
    context.off("request", onRequest);
    context.off("response", onResponse);
    context.off("requestfailed", onRequestFailed);
    await Promise.allSettled([...pending]);
    if (active || !exactCompletedReadCycles(cycles)) failed = true;
    return evaluateBoundDraftReadProof({ list, details, failed, rows,
      managementCode, title, priceYen, expectedRowCount, ownDraftId,
      reviewed, listReadCount, detailReadCounts, shopId, baseline });
  } };
}

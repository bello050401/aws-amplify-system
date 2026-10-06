const SHOP = "evkhihBFFNn5hukMS9s36H";
const ID = /^[A-Za-z0-9_-]{1,100}$/;
const METHODS = new Set(["POST", "PUT", "PATCH"]);
const PATH_WORDS = new Set(["graphql", "api", "v1", "v2", "v3", "seller", "shops",
  "products", "product", "drafts", "draft", "images", "image", "assets",
  "asset", "upload"]);
const JSON_KEYS = new Set(["query", "operationName", "variables", "input", "data",
  "createProduct", "updateProduct", "createProductDraft", "saveProductDraft",
  "product", "productDraft", "id", "productId", "productDraftId", "shopId",
  "name", "description", "price", "status", "condition", "categoryId",
  "brandId", "variants", "skuCode", "quantity", "stockQuantity", "images",
  "imageUrls", "assetIds", "shippingMethod", "shippingPayer", "shippingDuration",
  "shippingFromStateId", "shippingConfigurationId", "errors", "extensions", "code"]);
const STATES = new Set(["UNOPENED", "PRIVATE", "OPENED", "PUBLIC", "PUBLISHED"]);
const MAX_EVENTS = 40;
const MAX_KEYS = 80;
const MAX_JSON_BYTES = 128 * 1024;
const UNKNOWN_DRAFT = "UNKNOWN_UNATTRIBUTED";

function destination(raw) {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" ||
        !(url.hostname === "mercari-shops.com" ||
          url.hostname.endsWith(".mercari-shops.com"))) return null;
    return { host: url.hostname === "mercari-shops.com" ? "mercari-shops.com" :
        url.hostname === "api.mercari-shops.com" ? "api.mercari-shops.com" :
          "*.mercari-shops.com",
      path: "/" + url.pathname.split("/").filter(Boolean).slice(0, 12)
        .map(part => PATH_WORDS.has(part) ? part : ":value").join("/") };
  } catch { return null; }
}

function keyPaths(value) {
  const result = [];
  let truncated = false;
  const visit = (node, prefix, depth) => {
    if (!node || typeof node !== "object") return;
    if (depth > 5) { if (Object.keys(node).length) truncated = true; return; }
    const entries = Array.isArray(node) ? node.map(item => ["[]", item]) :
      Object.entries(node);
    for (const [key, child] of entries) {
      if (key !== "[]" && !JSON_KEYS.has(key)) continue;
      if (result.length >= MAX_KEYS) { truncated = true; break; }
      const path = key === "[]" ? `${prefix}[]` : prefix ? `${prefix}.${key}` : key;
      result.push(path);
      visit(child, path, depth + 1);
    }
  };
  visit(value, "", 0);
  return { paths: result, truncated };
}

function responseResult(value) {
  if (Array.isArray(value?.errors) && value.errors.length) return null;
  const product = value?.data?.createProduct?.product;
  if (!product || typeof product !== "object" || Array.isArray(product) ||
      typeof product.id !== "string" || !ID.test(product.id) ||
      !STATES.has(product.status) ||
      product.shopId !== SHOP) return null;
  return { resultId: product.id, resultState: product.status };
}

function draftFromPage(page) {
  try {
    const url = new URL(page.url());
    if (url.origin !== "https://mercari-shops.com" ||
        url.pathname !== `/seller/shops/${SHOP}/products/create`) return null;
    const values = url.searchParams.getAll("productDraftId");
    return values.length === 1 && ID.test(values[0]) ? values[0] : null;
  } catch { return null; }
}

function inScope(page) {
  try {
    const url = new URL(page.url());
    return url.origin === "https://mercari-shops.com" &&
      [`/seller/shops/${SHOP}/products`,
        `/seller/shops/${SHOP}/products/create`].includes(url.pathname);
  } catch { return false; }
}

/** Revalidates the entire persistence boundary, including ordered JSON key paths. */
export function safeFutureCreateTrafficSummary(value) {
  if (!value || !Array.isArray(value.events) || value.events.length > MAX_EVENTS ||
      !Array.isArray(value.draftIds) || value.draftIds.length > 3 ||
      !["UNVERIFIED", "TRUNCATED"].includes(value.captureStatus)) return null;
  const events = [];
  for (const item of value.events) {
    if (!item || Object.keys(item).sort().join(",") !==
        ["order", "method", "host", "path", "requestJsonKeys", "responseJsonKeys",
          "httpStatus", "resultId", "resultState"].sort().join(",") ||
        item.order !== events.length + 1 || !METHODS.has(item.method) ||
        !["mercari-shops.com", "api.mercari-shops.com", "*.mercari-shops.com"].includes(item.host) ||
        typeof item.path !== "string" || item.path.length > 180 ||
        !item.path.startsWith("/") ||
        item.path.split("/").slice(1).some(part => part !== ":value" && !PATH_WORDS.has(part)) ||
        !Number.isInteger(item.httpStatus) && item.httpStatus !== null ||
        item.httpStatus !== null && (item.httpStatus < 100 || item.httpStatus > 599) ||
        item.resultId !== null && (typeof item.resultId !== "string" ||
          !ID.test(item.resultId)) ||
        !STATES.has(item.resultState) && item.resultState !== null ||
        (item.resultId === null) !== (item.resultState === null)) return null;
    for (const field of ["requestJsonKeys", "responseJsonKeys"]) {
      if (!Array.isArray(item[field]) || item[field].length > MAX_KEYS ||
          item[field].some(path => typeof path !== "string" || path.length > 180 ||
            path.split(".").some(part => !JSON_KEYS.has(part.replace(/\[\]$/, ""))))) return null;
    }
    events.push({ order: item.order, method: item.method, host: item.host,
      path: item.path, requestJsonKeys: [...item.requestJsonKeys],
      responseJsonKeys: [...item.responseJsonKeys], httpStatus: item.httpStatus,
      resultId: item.resultId, resultState: item.resultState });
  }
  if (value.draftIds.some(item => !item || Object.keys(item).sort().join(",") !==
      "id,state" || typeof item.id !== "string" ||
      !ID.test(item.id) || item.state !== UNKNOWN_DRAFT) ||
      new Set(value.draftIds.map(item => item.id)).size !== value.draftIds.length)
    return null;
  return { events, draftIds: value.draftIds.map(item => ({ id: item.id,
    state: UNKNOWN_DRAFT })), captureStatus: value.captureStatus,
    listingConfirmed: false };
}

/** Passive metadata observer. Attach before opening the product list or create page. */
export function observeFutureCreateTraffic(context, { page, shopId = SHOP,
  drainMs = 2000 } = {}) {
  if (shopId !== SHOP || typeof context?.on !== "function" ||
      typeof context?.off !== "function" || typeof page?.url !== "function" ||
      !Number.isInteger(drainMs) || drainMs < 0 || drainMs > 5000)
    throw Error("Invalid fixed future-create observation target");
  const events = [];
  const drafts = new Set();
  const byRequest = new WeakMap();
  const pending = new Set();
  let accepting = true;
  let stopped = false;
  let stopPromise = null;
  let overflowed = false;
  const captureDraft = () => {
    const id = draftFromPage(page);
    if (id && !drafts.has(id)) {
      if (drafts.size < 3) drafts.add(id);
      else overflowed = true;
    }
  };
  const track = work => {
    const task = Promise.resolve().then(work).catch(() => { overflowed = true; });
    pending.add(task);
    task.finally(() => pending.delete(task));
  };
  const onRequest = request => {
    captureDraft();
    if (!accepting || !inScope(page) ||
        !METHODS.has(request.method()) ||
        !["fetch", "xhr"].includes(request.resourceType())) return;
    let sourcePage;
    try { sourcePage = request.frame().page(); } catch { return; }
    if (sourcePage !== page) return;
    const target = destination(request.url());
    if (!target) return;
    if (events.length >= MAX_EVENTS) { overflowed = true; return; }
    const entry = { order: events.length + 1, method: request.method(), ...target,
      requestJsonKeys: [], responseJsonKeys: [], httpStatus: null,
      resultId: null, resultState: null };
    events.push(entry);
    byRequest.set(request, entry);
    track(async () => {
      const contentType = (await request.headerValue("content-type")) ?? "";
      if (!/^application\/(?:json|graphql\+json)(?:;|$)/i.test(contentType)) return;
      const raw = request.postDataBuffer();
      if (!Buffer.isBuffer(raw) || raw.length > MAX_JSON_BYTES) {
        overflowed = true; return;
      }
      try {
        const body = JSON.parse(raw.toString("utf8"));
        const keys = keyPaths(body);
        if (!stopped) entry.requestJsonKeys = keys.paths;
        if (keys.truncated) overflowed = true;
      } catch { overflowed = true; /* No raw request or error text leaves memory. */ }
    });
  };
  const onResponse = response => {
    captureDraft();
    const entry = byRequest.get(response.request());
    if (!entry) return;
    track(async () => {
      const status = response.status();
      if (!stopped && Number.isInteger(status) && status >= 100 && status <= 599)
        entry.httpStatus = status;
      const contentType = (await response.headerValue("content-type")) ?? "";
      if (!/^application\/(?:json|graphql\+json)(?:;|$)/i.test(contentType)) return;
      const contentLength = Number(await response.headerValue("content-length"));
      if (Number.isFinite(contentLength) && contentLength > MAX_JSON_BYTES) {
        overflowed = true; return;
      }
      const raw = await response.body();
      if (!Buffer.isBuffer(raw) || raw.length > MAX_JSON_BYTES) {
        overflowed = true; return;
      }
      try {
        const body = JSON.parse(raw.toString("utf8"));
        if (!stopped) {
          const keys = keyPaths(body);
          entry.responseJsonKeys = keys.paths;
          if (keys.truncated) overflowed = true;
          const result = status === 200 ? responseResult(body) : null;
          if (result) Object.assign(entry, result);
        }
      } catch { overflowed = true; /* No raw response or error text leaves memory. */ }
    });
  };
  const poll = setInterval(captureDraft, 100);
  context.on("request", onRequest);
  context.on("response", onResponse);
  return {
    async stop() {
      if (stopPromise) return stopPromise;
      stopPromise = (async () => {
        accepting = false;
        clearInterval(poll);
        context.off("request", onRequest);
        captureDraft();
        const deadline = Date.now() + drainMs;
        while (pending.size && Date.now() < deadline)
          await new Promise(resolve => setTimeout(resolve, Math.min(25, deadline - Date.now())));
        stopped = true;
        context.off("response", onResponse);
        return safeFutureCreateTrafficSummary({ events,
          draftIds: [...drafts].map(id => ({ id, state: UNKNOWN_DRAFT })),
          captureStatus: overflowed || pending.size ? "TRUNCATED" : "UNVERIFIED" });
      })();
      return stopPromise;
    },
  };
}

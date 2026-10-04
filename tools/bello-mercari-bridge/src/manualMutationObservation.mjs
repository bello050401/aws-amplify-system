const METHODS = new Set(["POST", "PUT", "PATCH"]);
const TYPES = new Set(["fetch", "xhr"]);
const FIELDS = new Set(["operationName", "query", "variables", "input", "product", "productId",
  "asset", "assetId", "image", "images", "imageUrls", "file", "files", "name", "description",
  "price", "categoryId", "condition", "status", "variants", "skuCode", "stockQuantity",
  "shippingDuration", "shippingFromStateId", "shippingMethod", "shippingPayer",
  "shippingConfigurationId", "brandId", "data", "payload"]);
const PATH_WORDS = new Set(["api", "v1", "v2", "v3", "seller", "shops", "products",
  "product", "images", "image", "assets", "asset", "upload", "graphql"]);
const STATES = new Set(["OPENED", "UNOPENED", "DRAFT", "PUBLISHED", "PRIVATE", "PUBLIC"]);
const MAX_EVENTS = 20;
const MAX_FIELDS = 64;
const MAX_JSON_BYTES = 128 * 1024;
const MAX_MULTIPART_BYTES = 20 * 1024 * 1024;

const kind = value => value === null ? "null" : Array.isArray(value) ? "array" : typeof value;

function destination(raw) {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") return null;
    if (url.hostname === "mercari-shops.com" || url.hostname.endsWith(".mercari-shops.com"))
      return { host: url.hostname === "mercari-shops.com" ? "mercari-shops.com" :
        "*.mercari-shops.com", path: "/" + url.pathname.split("/").filter(Boolean).slice(0, 10)
          .map(part => PATH_WORDS.has(part) ? part : ":value").join("/") };
    return { host: "external-https", path: "/:value" };
  } catch { return null; }
}

function jsonFields(value) {
  const fields = [];
  const visit = (node, path, depth) => {
    if (depth > 5 || fields.length >= MAX_FIELDS || !node || typeof node !== "object") return;
    const entries = Array.isArray(node) ? node.slice(0, 1).map(item => ["[]", item]) : Object.entries(node);
    for (const [key, child] of entries) {
      if (fields.length >= MAX_FIELDS) break;
      if (key !== "[]" && !FIELDS.has(key)) continue;
      const next = key === "[]" ? `${path}[]` : path ? `${path}.${key}` : key;
      fields.push({ field: next, type: kind(child) });
      visit(child, next, depth + 1);
    }
  };
  visit(value, "", 0);
  return fields;
}

function multipartFields(buffer, contentType) {
  const match = /(?:^|;)\s*boundary=(?:"([A-Za-z0-9'()+_,.\/:=?-]{1,70})"|([A-Za-z0-9'()+_,.\/:=?-]{1,70}))(?:;|$)/i.exec(contentType);
  if (!match || !Buffer.isBuffer(buffer) || buffer.length > MAX_MULTIPART_BYTES) return [];
  const boundary = Buffer.from(`--${match[1] ?? match[2]}`);
  const fields = [];
  let offset = 0;
  while (fields.length < MAX_FIELDS) {
    const start = buffer.indexOf(boundary, offset);
    if (start < 0) break;
    const headerStart = start + boundary.length + 2;
    const headerEnd = buffer.indexOf("\r\n\r\n", headerStart);
    if (headerEnd < 0 || headerEnd - headerStart > 4096) break;
    const header = buffer.subarray(headerStart, headerEnd).toString("latin1");
    const disposition = /^content-disposition:\s*form-data;([^\r\n]*)$/im.exec(header)?.[1] ?? "";
    const name = /(?:^|;)\s*name="([A-Za-z][A-Za-z0-9_]{0,63})"(?:;|$)/i.exec(disposition)?.[1];
    if (name && FIELDS.has(name)) fields.push({ field: name,
      type: /(?:^|;)\s*filename\s*=/i.test(disposition) ? "file" : "string" });
    offset = headerEnd + 4;
  }
  return fields;
}

function responseIdentity(body) {
  if (!body || typeof body !== "object") return {};
  const data = body.data ?? body;
  const candidate = data.createProduct?.product ?? data.updateProduct?.product ??
    data.product ?? data.uploadImage?.asset ?? data.asset ?? data.payload?.product;
  if (!candidate || typeof candidate !== "object") return {};
  const id = candidate.id;
  const status = candidate.status;
  return { ...(typeof id === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(id) ? { id } : {}),
    ...(STATES.has(status) ? { state: status } : {}) };
}

/** Recheck all observable metadata at the local UI boundary. */
export function safeManualMutationSummary(items) {
  if (!Array.isArray(items)) return [];
  return items.slice(0, MAX_EVENTS).flatMap(item => {
    if (!item || !Number.isInteger(item.order) || item.order < 1 || item.order > MAX_EVENTS ||
        !METHODS.has(item.method) || !["mercari-shops.com", "*.mercari-shops.com", "external-https"].includes(item.host) ||
        typeof item.path !== "string" || item.path.length > 160 || !item.path.startsWith("/") ||
        item.path.split("/").slice(1).some(part => part !== ":value" && !PATH_WORDS.has(part)) ||
        !["json", "multipart", "form", "unobserved"].includes(item.bodyType) ||
        (item.httpStatus !== null && (!Number.isInteger(item.httpStatus) || item.httpStatus < 100 || item.httpStatus > 599)) ||
        !Array.isArray(item.fields) || item.fields.length > MAX_FIELDS ||
        !item.auth || ["authorization", "cookie", "csrf"].some(key => typeof item.auth[key] !== "boolean") ||
        (item.id !== undefined && (typeof item.id !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(item.id))) ||
        (item.state !== undefined && !STATES.has(item.state))) return [];
    const fields = item.fields.flatMap(field => {
      if (!field || typeof field.field !== "string" || typeof field.type !== "string" ||
          !["null", "array", "object", "string", "number", "boolean", "file"].includes(field.type) ||
          field.field.split(".").some(part => !FIELDS.has(part.replace(/\[\]$/, "")))) return [];
      return [{ field: field.field, type: field.type }];
    });
    return [{ order: item.order, method: item.method, host: item.host, path: item.path,
      bodyType: item.bodyType, fields, auth: { authorization: item.auth.authorization,
        cookie: item.auth.cookie, csrf: item.auth.csrf }, httpStatus: item.httpStatus,
      ...(item.id ? { id: item.id } : {}), ...(item.state ? { state: item.state } : {}) }];
  });
}

/** Passive, memory-only metadata for one exact edit page. It never sends a request or operates a form. */
export function observeManualShopsMutation(page, expectedEditUrl, { drainMs = 2000 } = {}) {
  if (!/^https:\/\/mercari-shops\.com\/seller\/shops\/[A-Za-z0-9_-]{1,100}\/products\/[A-Za-z0-9_-]{1,100}\/edit$/.test(expectedEditUrl) ||
      typeof page?.on !== "function" || typeof page?.off !== "function" ||
      !Number.isInteger(drainMs) || drainMs < 0 || drainMs > 5000)
    throw Error("An exact existing Shops edit page is required");
  const events = [];
  const byRequest = new WeakMap();
  const pending = new Set();
  const awaiting = new Set();
  let accepting = true;
  let stopped = false;
  let stopPromise = null;
  const track = work => {
    const task = Promise.resolve().then(work).catch(() => {});
    pending.add(task);
    task.finally(() => pending.delete(task));
  };
  const onRequest = request => {
    if (!accepting || page.url() !== expectedEditUrl || events.length >= MAX_EVENTS) return;
    const method = request.method();
    const target = destination(request.url());
    if (!METHODS.has(method) || !TYPES.has(request.resourceType()) || !target) return;
    const entry = { order: events.length + 1, method, ...target, bodyType: "unobserved",
      fields: [], auth: { authorization: false, cookie: false, csrf: false }, httpStatus: null };
    events.push(entry);
    byRequest.set(request, entry);
    awaiting.add(request);
    track(async () => {
      const contentType = (await request.headerValue("content-type")) ?? "";
      const auth = { authorization: Boolean(await request.headerValue("authorization")),
        cookie: Boolean(await request.headerValue("cookie")),
        csrf: Boolean(await request.headerValue("x-csrf-token")) };
      const buffer = request.postDataBuffer();
      let bodyType = "unobserved";
      let fields = [];
      if (/^application\/(?:json|graphql\+json)(?:;|$)/i.test(contentType) &&
          buffer && buffer.length <= MAX_JSON_BYTES) {
        bodyType = "json";
        fields = jsonFields(request.postDataJSON());
      } else if (/^multipart\/form-data(?:;|$)/i.test(contentType)) {
        bodyType = "multipart";
        fields = multipartFields(buffer, contentType);
      } else if (/^application\/x-www-form-urlencoded(?:;|$)/i.test(contentType) &&
                 buffer && buffer.length <= MAX_JSON_BYTES) {
        bodyType = "form";
        fields = jsonFields(request.postDataJSON());
      }
      if (!stopped) Object.assign(entry, { auth, bodyType, fields });
    });
  };
  const onResponse = response => {
    const entry = byRequest.get(response.request());
    if (!entry) return;
    track(async () => {
      try {
        const status = response.status();
        if (!stopped) entry.httpStatus = Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
        const contentType = (await response.headerValue("content-type")) ?? "";
        if (/^application\/(?:json|graphql\+json)(?:;|$)/i.test(contentType)) {
          const identity = responseIdentity(await response.json());
          if (!stopped) Object.assign(entry, identity);
        }
        if (typeof response.finished === "function") await response.finished();
      } finally {
        awaiting.delete(response.request());
        entry.completedAt = Date.now();
      }
    });
  };
  const onRequestFailed = request => {
    const entry = byRequest.get(request);
    if (entry) { awaiting.delete(request); entry.completedAt = Date.now(); }
  };
  page.on("request", onRequest);
  page.on("response", onResponse);
  page.on("requestfailed", onRequestFailed);
  return {
    checkpoint: () => events.length,
    snapshot: () => events.map(entry => ({ ...entry, fields: entry.fields.map(field => ({ ...field })),
      auth: { ...entry.auth } })),
    waitForPostClickIdle: async (afterOrder, timeoutMs = 12000) => {
      if (!Number.isInteger(afterOrder) || afterOrder < 0 || afterOrder > MAX_EVENTS ||
          !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000)
        throw Error("Invalid post-click observation window");
      const deadline = Date.now() + timeoutMs;
      while (!stopped && Date.now() < deadline) {
        const later = events.filter(entry => entry.order > afterOrder);
        if (later.length > 0 && later.every(entry => Number.isInteger(entry.completedAt)) &&
            Date.now() - Math.max(...later.map(entry => entry.completedAt)) >= 1000) return true;
        await new Promise(resolve => setTimeout(resolve, Math.min(50, deadline - Date.now())));
      }
      return false;
    },
    waitForPrivateSaveAcknowledgement: async (expectedId, timeoutMs = 12000, afterOrder = 0) => {
      if (typeof expectedId !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(expectedId) ||
          !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000 ||
          !Number.isInteger(afterOrder) || afterOrder < 0 || afterOrder > MAX_EVENTS)
        throw Error("Invalid exact-product acknowledgement target");
      // Response metadata is insufficient to distinguish the save from a read.
      // Drain briefly for observation, but never promote an unverified contract.
      await new Promise(resolve => setTimeout(resolve, Math.min(timeoutMs, drainMs)));
      return false;
    },
    stop: () => stopPromise ??= (async () => {
      accepting = false;
      page.off("request", onRequest);
      page.off("requestfailed", onRequestFailed);
      const deadline = Date.now() + drainMs;
      while ((awaiting.size || pending.size) && Date.now() < deadline)
        await new Promise(resolve => setTimeout(resolve, Math.min(25, deadline - Date.now())));
      stopped = true;
      page.off("response", onResponse);
      return events.map(entry => ({ ...entry, fields: entry.fields.map(field => ({ ...field })),
        auth: { ...entry.auth } }));
    })(),
  };
}

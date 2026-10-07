import { createHash } from "node:crypto";

const MAX_CANDIDATES = 8;
const MAX_BODY_BYTES = 128 * 1024;
const MAX_FIELDS = 32;
const VARIABLE_KEYS = new Set(["id", "productId", "remoteId", "shopId", "input", "filter",
  "first", "after", "limit", "offset", "page", "sort", "ids", "includeImages"]);
const MATCHES = new Set(["MATCH", "DIFFERENT", "UNOBSERVED"]);
const ERRORS = new Set(["NONE", "PRESENT", "UNOBSERVED"]);
const TYPES = new Set(["null", "array", "object", "string", "number", "boolean"]);
const OPERATION = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const ID = /^[A-Za-z0-9_-]{1,100}$/;

function kind(value) {
  return value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
}

function variableShape(value) {
  const fields = [];
  let complete = Boolean(value && typeof value === "object" && !Array.isArray(value));
  const visit = (node, prefix, depth) => {
    if (!node || typeof node !== "object" || Array.isArray(node)) return;
    if (depth >= 4) { complete = false; return; }
    for (const [key, child] of Object.entries(node)) {
      if (!VARIABLE_KEYS.has(key) || fields.length >= MAX_FIELDS) { complete = false; continue; }
      const type = kind(child);
      if (!TYPES.has(type)) { complete = false; continue; }
      const field = prefix ? `${prefix}.${key}` : key;
      fields.push({ field, type });
      if (type === "object") visit(child, field, depth + 1);
    }
  };
  visit(value, "", 0);
  return { fields, complete };
}

function matchIdentity(variables, keys, expected) {
  const found = [];
  const visit = (node, depth) => {
    if (!node || typeof node !== "object" || Array.isArray(node) || depth > 3) return;
    for (const [key, value] of Object.entries(node)) {
      if (keys.includes(key) && typeof value === "string") found.push(value);
      if (key === "input" || key === "filter") visit(value, depth + 1);
    }
  };
  visit(variables, 0);
  return found.length === 1 && ID.test(found[0]) ?
    found[0] === expected ? "MATCH" : "DIFFERENT" : "UNOBSERVED";
}

function safeOperation(value) {
  return typeof value === "string" && OPERATION.test(value) &&
    !/(?:token|secret|password|cookie|email|phone|address)/i.test(value) ? value : null;
}

/** Revalidate at both persistence and UI boundaries. Never return input objects. */
export function safeReadQueryCandidates(items) {
  if (!Array.isArray(items)) return [];
  return items.slice(0, MAX_CANDIDATES).flatMap(item => {
    if (!item || item.method !== "POST" || item.host !== "mercari-shops.com" ||
        item.path !== "/graphql" || item.operationType !== "query" ||
        (item.operationName !== null && safeOperation(item.operationName) !== item.operationName) ||
        (item.querySha256 !== null && !/^[a-f0-9]{64}$/.test(item.querySha256)) ||
        !Array.isArray(item.variableFields) || item.variableFields.length > MAX_FIELDS ||
        typeof item.variableShapeComplete !== "boolean" ||
        !MATCHES.has(item.requestProductMatch) || !MATCHES.has(item.requestShopMatch) ||
        !MATCHES.has(item.responseProductMatch) || !MATCHES.has(item.responseShopMatch) ||
        (item.requestProductMatch !== "MATCH" && item.responseProductMatch !== "MATCH") ||
        item.requestShopMatch === "DIFFERENT" || item.responseShopMatch === "DIFFERENT" ||
        !ERRORS.has(item.graphqlErrors) ||
        (item.httpStatus !== null && (!Number.isInteger(item.httpStatus) ||
          item.httpStatus < 100 || item.httpStatus > 599)) ||
        typeof item.authPresenceObserved !== "boolean" ||
        !item.authPresence || ["authorization", "cookie", "csrf"].some(key =>
          typeof item.authPresence[key] !== "boolean")) return [];
    const fields = item.variableFields.flatMap(value => {
      if (!value || typeof value.field !== "string" || !TYPES.has(value.type) ||
          value.field.split(".").some(part => !VARIABLE_KEYS.has(part))) return [];
      return [{ field: value.field, type: value.type }];
    });
    if (fields.length !== item.variableFields.length) return [];
    return [{ method: "POST", host: "mercari-shops.com", path: "/graphql",
      operationType: "query", operationName: item.operationName,
      querySha256: item.querySha256, variableFields: fields,
      variableShapeComplete: item.variableShapeComplete,
      requestProductMatch: item.requestProductMatch, requestShopMatch: item.requestShopMatch,
      responseProductMatch: item.responseProductMatch, responseShopMatch: item.responseShopMatch,
      graphqlErrors: item.graphqlErrors, httpStatus: item.httpStatus,
      authPresenceObserved: item.authPresenceObserved,
      authPresence: { authorization: item.authPresence.authorization,
        cookie: item.authPresence.cookie, csrf: item.authPresence.csrf } }];
  });
}

/** Passive listener for one exact-product read. No request is sent by this observer. */
export function observeShopsReadQueries(context, { shopId, remoteId, page }) {
  if (typeof context?.on !== "function" || typeof context?.off !== "function" ||
      !page || !ID.test(shopId) || !ID.test(remoteId))
    throw Error("An exact read target is required");
  const candidates = [];
  const byRequest = new WeakMap();
  const pending = new Set();
  let stopped = false;
  const track = work => {
    const task = Promise.resolve().then(work).catch(() => {});
    pending.add(task);
    task.finally(() => pending.delete(task));
  };
  const onRequest = request => {
    let requestPage;
    try { requestPage = request.frame().page(); } catch { return; }
    if (stopped || candidates.length >= MAX_CANDIDATES || request.method() !== "POST" ||
        requestPage !== page ||
        !["fetch", "xhr"].includes(request.resourceType()) ||
        request.url() !== "https://mercari-shops.com/graphql") return;
    const buffer = request.postDataBuffer();
    if (!buffer || buffer.length > MAX_BODY_BYTES) return;
    let body;
    try { body = JSON.parse(buffer.toString("utf8")); } catch { return; }
    if (!body || typeof body !== "object" || Array.isArray(body) ||
        typeof body.query !== "string" || body.query.length > MAX_BODY_BYTES) return;
    const sourceWithoutComments = body.query.replace(/#[^\r\n]*/g, "");
    const queryHead = /^\s*query\s+([A-Za-z_][A-Za-z0-9_]*)\b/.exec(sourceWithoutComments);
    if (!queryHead || /\b(?:mutation|subscription)\b/.test(sourceWithoutComments) ||
        (sourceWithoutComments.match(/\bquery\b/g) ?? []).length !== 1) return;
    const queryName = safeOperation(queryHead[1]);
    if (!queryName || (body.operationName !== undefined && body.operationName !== queryName)) return;
    const operationName = queryName;
    const variables = body.variables;
    const shape = variableShape(variables);
    const requestProductMatch = matchIdentity(variables, ["id", "productId", "remoteId"], remoteId);
    const requestShopMatch = matchIdentity(variables, ["shopId"], shopId);
    if (requestProductMatch === "DIFFERENT" || requestShopMatch === "DIFFERENT") return;
    const entry = { method: "POST", host: "mercari-shops.com", path: "/graphql",
      operationType: "query", operationName,
      querySha256: createHash("sha256").update(body.query).digest("hex"),
      variableFields: shape.fields, variableShapeComplete: shape.complete,
      requestProductMatch, requestShopMatch,
      responseProductMatch: "UNOBSERVED", responseShopMatch: "UNOBSERVED",
      graphqlErrors: "UNOBSERVED", httpStatus: null,
      authPresenceObserved: false,
      authPresence: { authorization: false, cookie: false, csrf: false } };
    candidates.push(entry);
    byRequest.set(request, entry);
    track(async () => {
      const values = await Promise.all(["authorization", "cookie", "x-csrf-token"]
        .map(name => request.headerValue(name)));
      entry.authPresence = { authorization: Boolean(values[0]),
        cookie: Boolean(values[1]), csrf: Boolean(values[2]) };
      entry.authPresenceObserved = true;
    });
  };
  const onResponse = response => {
    const entry = byRequest.get(response.request());
    if (!entry) return;
    track(async () => {
      const status = response.status();
      entry.httpStatus = Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
      const contentType = (await response.headerValue("content-type")) ?? "";
      if (!/^application\/(?:json|graphql\+json)(?:;|$)/i.test(contentType)) return;
      const length = Number(await response.headerValue("content-length"));
      if (Number.isFinite(length) && length > MAX_BODY_BYTES) return;
      const bytes = await response.body();
      if (bytes.length > MAX_BODY_BYTES) return;
      let body;
      try { body = JSON.parse(bytes.toString("utf8")); } catch { return; }
      entry.graphqlErrors = !body || typeof body !== "object" || Array.isArray(body) ?
        "UNOBSERVED" : !Object.hasOwn(body, "errors") ? "NONE" :
          !Array.isArray(body.errors) ? "UNOBSERVED" :
            body.errors.length ? "PRESENT" : "NONE";
      const data = body?.data;
      const product = data?.product ?? data?.shopProduct ?? data?.sellerProduct;
      if (product && typeof product === "object" && !Array.isArray(product)) {
        entry.responseProductMatch = typeof product.id === "string" && ID.test(product.id) ?
          product.id === remoteId ? "MATCH" : "DIFFERENT" : "UNOBSERVED";
        const responseShop = product.shopId ?? product.shop?.id;
        entry.responseShopMatch = typeof responseShop === "string" && ID.test(responseShop) ?
          responseShop === shopId ? "MATCH" : "DIFFERENT" : "UNOBSERVED";
      }
    });
  };
  context.on("request", onRequest);
  context.on("response", onResponse);
  return { stop: async () => {
    stopped = true;
    context.off("request", onRequest);
    const deadline = Date.now() + 2000;
    while (pending.size && Date.now() < deadline)
      await new Promise(resolve => setTimeout(resolve, 20));
    context.off("response", onResponse);
    return safeReadQueryCandidates(candidates);
  } };
}

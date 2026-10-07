const GRAPHQL_URL = "https://mercari-shops.com/graphql";
const ORIGIN = "https://mercari-shops.com";
const ID = /^[A-Za-z0-9_-]{1,100}$/;
const OPERATION_NAME = /^[A-Za-z_]{1,80}$/;
const MAX_BODY_BYTES = 512 * 1024;
const MAX_SHAPE_KEYS = 24;
const valueType = value => value === null ? "null" :
  Array.isArray(value) ? "array" : typeof value;

function pageKind(url, shopId) {
  try {
    const value = new URL(url);
    if (value.origin !== ORIGIN) return null;
    const base = `/seller/shops/${shopId}/products`;
    if (value.pathname === base &&
        [...value.searchParams.keys()].join() === "tab" &&
        value.searchParams.get("tab") === "draft") return "DRAFT_LIST";
    if (value.pathname === `${base}/create` &&
        [...value.searchParams.keys()].join() === "productDraftId" &&
        ID.test(value.searchParams.get("productDraftId") ?? ""))
      return "DRAFT_DETAIL";
  } catch { /* Unknown pages are ignored. */ }
  return null;
}

function queryOperation(request) {
  const bytes = request.postDataBuffer?.();
  if (!Buffer.isBuffer(bytes) || bytes.length < 1 ||
      bytes.length > MAX_BODY_BYTES) return null;
  let body;
  try { body = JSON.parse(bytes.toString("utf8")); } catch { return null; }
  if (!body || typeof body !== "object" || Array.isArray(body) ||
      !OPERATION_NAME.test(body.operationName ?? "") ||
      /(?:token|secret|cookie|auth|session|password|credential|key)/i
        .test(body.operationName) || typeof body.query !== "string" ||
      body.query.length > 200_000) return null;
  const source = body.query.replace(/#[^\r\n]*/g, "");
  const prefix = new RegExp(`^\\s*query\\s+${body.operationName}\\b`);
  if (!prefix.test(source) || /\b(?:mutation|subscription)\b/i.test(source) ||
      (source.match(/\bquery\b/g) ?? []).length !== 1) return null;
  return true;
}

function valueShape(value, depth = 0) {
  if (value === null) return "null";
  if (Array.isArray(value)) return depth >= 3 ? "array" :
    { type: "array", item: value.length ? valueShape(value[0], depth + 1) : "unknown" };
  if (typeof value !== "object") return typeof value;
  if (depth >= 3) return "object";
  const values = Object.values(value);
  const types = { null: 0, array: 0, object: 0, string: 0,
    number: 0, boolean: 0 };
  for (const item of values.slice(0, MAX_SHAPE_KEYS)) {
    const type = valueType(item);
    if (Object.hasOwn(types, type)) types[type]++;
  }
  return { type: "object", fieldCount: Math.min(values.length, MAX_SHAPE_KEYS),
    typeCounts: types, overLimit: values.length > MAX_SHAPE_KEYS };
}

/**
 * Passive in-memory metadata for normal draft-page GraphQL queries. No page
 * navigation, HTTP replay, request headers, variable values, or body is kept.
 * This is discovery evidence only and never authorizes a Shops mutation.
 */
export function observeDraftReadMetadata(context, { page, shopId,
  maxEvents = 24 } = {}) {
  if (!context || typeof context.on !== "function" ||
      typeof context.off !== "function" || !page || !ID.test(shopId ?? "") ||
      !Number.isSafeInteger(maxEvents) || maxEvents < 1 || maxEvents > 50)
    throw Error("Invalid draft metadata observer target");
  const requests = new WeakMap();
  const observations = [];
  const pending = new Set();
  let detached = false;
  let truncated = false;
  const track = work => {
    const task = Promise.resolve().then(work).catch(() => {});
    pending.add(task);
    task.finally(() => pending.delete(task));
  };
  const onRequest = request => {
    if (detached || request.method() !== "POST" ||
        !["fetch", "xhr"].includes(request.resourceType()) ||
        request.url() !== GRAPHQL_URL) return;
    let requestPage;
    try { requestPage = request.frame().page(); } catch { return; }
    if (requestPage !== page) return;
    const kind = pageKind(page.url(), shopId);
    if (!kind) return;
    if (queryOperation(request)) requests.set(request, { kind });
  };
  const onResponse = response => {
    if (detached) return;
    const metadata = requests.get(response.request());
    if (!metadata) return;
    if (observations.length + pending.size >= maxEvents) {
      truncated = true; return;
    }
    track(async () => {
      const status = response.status();
      const contentType = await response.headerValue("content-type");
      const json = /^application\/(?:json|graphql\+json)(?:\s*;|$)/i.test(contentType ?? "");
      let responseShape = null;
      let hasErrors = null;
      if (json && status === 200) {
        const bytes = await response.body();
        if (Buffer.isBuffer(bytes) && bytes.length <= MAX_BODY_BYTES) {
          try {
            const body = JSON.parse(bytes.toString("utf8"));
            if (body && typeof body === "object" && !Array.isArray(body)) {
              responseShape = valueShape(body.data ?? null);
              hasErrors = body.errors === undefined ? false :
                Array.isArray(body.errors) ? body.errors.length > 0 : null;
            }
          } catch { /* Values and error messages are never retained. */ }
        }
      }
      observations.push({ pageKind: metadata.kind,
        operationClass: "NAMED_QUERY", httpStatus: status,
        responseShape, hasErrors });
    });
  };
  context.on("request", onRequest);
  context.on("response", onResponse);
  return { async stop() {
    detached = true;
    context.off("request", onRequest);
    context.off("response", onResponse);
    await Promise.allSettled([...pending]);
    return { status: truncated ? "METADATA_TRUNCATED" : "METADATA_ONLY",
      observations: observations.slice(0, maxEvents), allowFinalCreate: false };
  } };
}

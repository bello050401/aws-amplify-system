import { createHash } from "node:crypto";

const GRAPHQL_URL = "https://mercari-shops.com/graphql";
const MAX_BYTES = 128 * 1024;
const ID = /^[A-Za-z0-9_-]{1,100}$/;
const SHA = /^[a-f0-9]{64}$/;
const RESULTS = new Set(["MATCHED", "NO_EXACT_NORMAL_READ", "NORMAL_READ_UNVERIFIED",
  "REQUEST_CONTEXT_UNAVAILABLE", "DIRECT_HTTP_UNVERIFIED", "DIRECT_RESPONSE_UNVERIFIED",
  "DIRECT_AUTH_REQUIRED", "DIRECT_REQUEST_FAILED"]);

function exactProduct(body, shopId, remoteId) {
  if (!body || typeof body !== "object" || Array.isArray(body) ||
      body.errors !== undefined && (!Array.isArray(body.errors) || body.errors.length) ||
      !body.data || typeof body.data !== "object") return false;
  const product = body.data.product ?? body.data.shopProduct ?? body.data.sellerProduct;
  return product?.id === remoteId && (product.shopId ?? product.shop?.id) === shopId;
}

function exactReadPayload(bytes, remoteId, querySha256) {
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX_BYTES) return false;
  let body;
  try { body = JSON.parse(bytes.toString("utf8")); } catch { return false; }
  if (!body || typeof body !== "object" || Array.isArray(body) ||
      Object.keys(body).some(key => !["operationName", "query", "variables"].includes(key)) ||
      typeof body.query !== "string" ||
      (body.operationName !== undefined && body.operationName !== "EditProductPage") ||
      !body.variables || typeof body.variables !== "object" ||
      Array.isArray(body.variables) || Object.keys(body.variables).length !== 1 ||
      body.variables.id !== remoteId ||
      createHash("sha256").update(body.query).digest("hex") !== querySha256) return false;
  const source = body.query.replace(/#[^\r\n]*/g, "");
  return /^\s*query\s+EditProductPage\b/.test(source) &&
    (source.match(/\bquery\b/g) ?? []).length === 1 &&
    !/\b(?:mutation|subscription)\b/.test(source);
}

function jsonType(value) {
  return /^application\/(?:json|graphql\+json)(?:;\s*charset=utf-8)?$/i.test(value ?? "");
}

/** One normal exact read gates one direct HTTP read in the same authenticated context. */
export function observeExactReadForDirectProbe(context, {
  page, shopId, remoteId, querySha256, waitMs = 12000,
}) {
  if (!page || !ID.test(shopId) || !ID.test(remoteId) || !SHA.test(querySha256) ||
      !Number.isInteger(waitMs) || waitMs < 1 || waitMs > 12000 ||
      typeof context?.on !== "function" || typeof context?.off !== "function")
    throw Error("Invalid exact read probe target");
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
    if (stopped || candidates.length >= 2 || requestPage !== page ||
        request.method() !== "POST" || !["fetch", "xhr"].includes(request.resourceType()) ||
        request.url() !== GRAPHQL_URL) return;
    const bytes = request.postDataBuffer();
    if (!exactReadPayload(bytes, remoteId, querySha256)) return;
    const candidate = { request, bytes: Buffer.from(bytes), contentType: null,
      normalStatus: null, normalMatched: false };
    candidates.push(candidate);
    byRequest.set(request, candidate);
    track(async () => {
      const contentType = await request.headerValue("content-type");
      if (jsonType(contentType)) candidate.contentType = contentType;
    });
  };
  const onResponse = response => {
    const candidate = byRequest.get(response.request());
    if (!candidate) return;
    track(async () => {
      candidate.normalStatus = response.status();
      if (candidate.normalStatus !== 200 || !jsonType(await response.headerValue("content-type"))) return;
      const bytes = await response.body();
      if (!Buffer.isBuffer(bytes) || bytes.length > MAX_BYTES) return;
      let body;
      try { body = JSON.parse(bytes.toString("utf8")); } catch { return; }
      candidate.normalMatched = exactProduct(body, shopId, remoteId);
    });
  };
  context.on("request", onRequest);
  context.on("response", onResponse);
  const detach = () => {
    stopped = true;
    context.off("request", onRequest);
    context.off("response", onResponse);
  };
  const erase = () => {
    for (const candidate of candidates) candidate.bytes.fill(0);
    candidates.length = 0;
  };
  return {
    async probe() {
      const deadline = Date.now() + waitMs;
      while (Date.now() < deadline && !candidates.some(item => item.normalMatched && item.contentType))
        await new Promise(resolve => setTimeout(resolve, 50));
      detach();
      const drainUntil = Date.now() + 2000;
      while (pending.size && Date.now() < drainUntil)
        await new Promise(resolve => setTimeout(resolve, 20));
      const matches = candidates.filter(item => item.normalMatched && item.contentType);
      if (matches.length !== 1) {
        const outcome = candidates.length ? "NORMAL_READ_UNVERIFIED" : "NO_EXACT_NORMAL_READ";
        erase();
        return { outcome, httpStatus: null };
      }
      if (typeof context.request?.post !== "function") {
        erase();
        return { outcome: "REQUEST_CONTEXT_UNAVAILABLE", httpStatus: null };
      }
      const candidate = matches[0];
      try {
        // BrowserContext.request uses this context's cookie jar. No cookie/token value is read.
        const response = await context.request.post(GRAPHQL_URL, {
          data: candidate.bytes, headers: { "content-type": candidate.contentType },
          maxRedirects: 0, failOnStatusCode: false, timeout: 15000,
        });
        const status = response.status();
        if (status === 401 || status === 403)
          return { outcome: "DIRECT_AUTH_REQUIRED", httpStatus: status };
        if (status !== 200)
          return { outcome: "DIRECT_HTTP_UNVERIFIED", httpStatus: status };
        const bytes = await response.body();
        if (!Buffer.isBuffer(bytes) || bytes.length > MAX_BYTES)
          return { outcome: "DIRECT_RESPONSE_UNVERIFIED", httpStatus: status };
        let body;
        try { body = JSON.parse(bytes.toString("utf8")); } catch {
          return { outcome: "DIRECT_RESPONSE_UNVERIFIED", httpStatus: status };
        }
        return { outcome: exactProduct(body, shopId, remoteId) ? "MATCHED" :
          "DIRECT_RESPONSE_UNVERIFIED", httpStatus: status };
      } catch {
        return { outcome: "DIRECT_REQUEST_FAILED", httpStatus: null };
      } finally { erase(); }
    },
    stop() { detach(); erase(); },
  };
}

export function safeDirectReadProbeResult(value) {
  if (!value || !RESULTS.has(value.outcome) ||
      (value.httpStatus !== null && (!Number.isInteger(value.httpStatus) ||
        value.httpStatus < 100 || value.httpStatus > 599)))
    return { outcome: "DIRECT_RESPONSE_UNVERIFIED", httpStatus: null };
  return { outcome: value.outcome, httpStatus: value.httpStatus };
}

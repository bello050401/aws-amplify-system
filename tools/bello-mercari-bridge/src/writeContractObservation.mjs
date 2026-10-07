import { createHash } from "node:crypto";

const GRAPHQL_URL = "https://mercari-shops.com/graphql";
const MAX_BYTES = 128 * 1024;
const ID = /^[A-Za-z0-9_-]{1,100}$/;
const SKU = /^[A-Za-z0-9_-]{1,50}$/;
const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const HASH = /^[a-f0-9]{64}$/;
const KINDS = new Set(["UPDATE_PRODUCT", "CREATE_PRODUCT", "IMAGE_ASSET"]);
const ROOTS = { updateProduct: "UPDATE_PRODUCT", createProduct: "CREATE_PRODUCT",
  createImageAsset: "IMAGE_ASSET" };
const REASONS = new Set(["MATCHED", "NO_REQUEST", "REQUEST_UNVERIFIED",
  "TARGET_MISMATCH", "OPERATION_MISMATCH", "MULTIPLE_REQUESTS",
  "RESPONSE_UNVERIFIED", "AUTH_REQUIRED", "TIMEOUT", "STOPPED",
  "IMAGE_MULTIPART_UNSUPPORTED", "NETWORK_NOT_OBSERVED",
  "DRAFT_AUTOSAVE_UI_OBSERVED"]);
const MATCHES = new Set(["MATCH", "DIFFERENT", "UNOBSERVED"]);
const FIELDS = new Set(["input", "id", "productId", "shopId", "name", "description",
  "price", "condition", "status", "categoryId", "variants", "skuCode",
  "quantity", "stockQuantity", "imageUrls", "images", "assetIds", "shippingFromStateId",
  "shippingMethod", "shippingPayer", "shippingDuration", "shippingConfigurationId",
  "brandId"]);
const TYPES = new Set(["null", "array", "object", "string", "number", "boolean"]);
const PRIVATE = new Set(["UNOPENED", "PRIVATE"]);
const BLOCKED_REMOTE_ID = "2JXePE4ke8UCBTj6mxc4cf";
const BLOCKED_INVENTORY = "B005795";
const validId = value => typeof value === "string" && ID.test(value);
const validSku = value => typeof value === "string" && SKU.test(value);
const validName = value => typeof value === "string" && NAME.test(value) &&
  !/(?:secret|token|password|cookie|session|api.?key|email|phone)/i.test(value);

function validTarget(target) {
  if (!target || !KINDS.has(target.kind) || !validId(target.shopId) ||
      !validSku(target.inventoryCode) || target.inventoryCode === BLOCKED_INVENTORY)
    return false;
  if (target.kind === "CREATE_PRODUCT")
    return target.remoteId === null && validSku(target.skuCode) &&
      target.skuCode !== BLOCKED_INVENTORY &&
      target.skuCode !== target.inventoryCode &&
      validId(target.excludedRemoteId) &&
      target.excludedRemoteId !== BLOCKED_REMOTE_ID &&
      typeof target.expectedName === "string" && target.expectedName.length > 0 &&
      target.expectedName.length <= 130 &&
      Number.isSafeInteger(target.priceYen) && target.priceYen > 0;
  return validId(target.remoteId) && target.remoteId !== BLOCKED_REMOTE_ID &&
    target.skuCode === null;
}

function tokens(source) {
  if (typeof source !== "string" || source.length > MAX_BYTES) return null;
  const result = [];
  for (let i = 0; i < source.length;) {
    const ch = source[i];
    if (/\s|,/.test(ch)) { i++; continue; }
    if (ch === "#") {
      while (i < source.length && source[i] !== "\n") i++;
      continue;
    }
    // An embedded string may contain a product value. Refuse it rather than
    // treating a textual "mutation" inside that value as an operation.
    if (ch === '"' || ch === "'") return null;
    const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(i));
    if (name) { result.push(name[0]); i += name[0].length; continue; }
    if ("{}()[]:$!=@|&.".includes(ch)) { result.push(ch); i++; continue; }
    if (/[-0-9]/.test(ch)) {
      const number = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?/.exec(source.slice(i));
      if (!number) return null;
      result.push("#number"); i += number[0].length; continue;
    }
    return null;
  }
  return result.length <= 8192 ? result : null;
}

function afterBalanced(items, start) {
  const pairs = { "(": ")", "{": "}", "[": "]" };
  if (!pairs[items[start]]) return -1;
  const stack = [];
  for (let i = start; i < items.length; i++) {
    const token = items[i];
    if (pairs[token]) stack.push(pairs[token]);
    else if ([")", "}", "]"].includes(token) && stack.pop() !== token) return -1;
    if (stack.length === 0) return i + 1;
  }
  return -1;
}

/** Deliberately accepts only one named mutation with one unaliased root field. */
function singleMutation(source) {
  const t = tokens(source);
  if (!t) return null;
  if (t[0] === "query" || t[0] === "subscription")
    return t.includes("mutation") ? null : { readOnly: true };
  if (t[0] !== "mutation" || !validName(t[1])) return null;
  const operationName = t[1];
  let i = 2;
  // Restrict this candidate to one declared input variable and one matching
  // root argument. A decoy variables.input must never certify another payload.
  if (t[i++] !== "(" || t[i++] !== "$" || t[i++] !== "input" ||
      t[i++] !== ":" || !validName(t[i++])) return null;
  if (t[i] === "!") i++;
  if (t[i++] !== ")" || t[i++] !== "{" || !validName(t[i])) return null;
  const rootField = t[i++];
  if (t[i++] !== "(" || t[i++] !== "input" || t[i++] !== ":" ||
      t[i++] !== "$" || t[i++] !== "input" || t[i++] !== ")" ||
      t[i] !== "{") return null;
  i = afterBalanced(t, i);
  if (i < 0 || t[i++] !== "}" || i !== t.length) return null;
  return { operationName, rootField, kind: ROOTS[rootField] ?? "OTHER_MUTATION" };
}

const valueType = value => value === null ? "null" : Array.isArray(value) ? "array" : typeof value;

function variableShape(value) {
  const fields = [];
  const visit = (node, prefix, depth) => {
    if (!node || typeof node !== "object" || depth > 4) return false;
    const entries = Array.isArray(node) ? node.slice(0, 1).map(item => ["[]", item]) :
      Object.entries(node);
    for (const [key, child] of entries) {
      if ((key !== "[]" && !FIELDS.has(key)) || fields.length >= 64) return false;
      const type = valueType(child);
      if (!TYPES.has(type)) return false;
      const field = key === "[]" ? `${prefix}[]` : prefix ? `${prefix}.${key}` : key;
      fields.push({ field, type });
      if ((type === "object" || type === "array") && !visit(child, field, depth + 1))
        return false;
    }
    return true;
  };
  return visit(value, "", 0) ? fields : null;
}

function requestIdentity(variables, target) {
  const input = variables?.input;
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  if (input.shopId !== undefined && input.shopId !== target.shopId) return false;
  if (!PRIVATE.has(input.status)) return false;
  if (target.kind === "UPDATE_PRODUCT") {
    const ids = [input.id, input.productId].filter(value => value !== undefined);
    if (ids.length !== 1 || ids[0] !== target.remoteId) return false;
    const skus = input.variants?.map(value => value?.skuCode);
    return skus === undefined || Array.isArray(skus) &&
      skus.length === 1 && skus[0] === target.inventoryCode;
  }
  if (target.kind === "CREATE_PRODUCT") {
    const variants = input.variants;
    return Array.isArray(variants) && variants.length === 1 &&
      variants[0]?.skuCode === target.skuCode &&
      input.name === target.expectedName && input.price === target.priceYen &&
      input.id === undefined && input.productId === undefined;
  }
  return false;
}

function inspectRequest(source, target) {
  if (!Buffer.isBuffer(source) || source.length === 0 || source.length > MAX_BYTES)
    return { reason: "REQUEST_UNVERIFIED" };
  const bytes = Buffer.from(source);
  let body = null;
  try {
    body = JSON.parse(bytes.toString("utf8"));
    if (!body || typeof body !== "object" || Array.isArray(body) ||
        Object.keys(body).some(key => !["query", "operationName", "variables"].includes(key)))
      return { reason: "REQUEST_UNVERIFIED" };
    const operation = singleMutation(body.query);
    if (operation?.readOnly) return { ignore: true };
    if (!operation || (body.operationName !== undefined &&
        body.operationName !== operation.operationName))
      return { reason: "REQUEST_UNVERIFIED" };
    const base = { operationName: operation.operationName,
      querySha256: createHash("sha256").update(body.query).digest("hex"),
      observedKind: operation.kind };
    if (operation.kind !== target.kind)
      return { ...base, reason: "OPERATION_MISMATCH" };
    if (target.kind === "IMAGE_ASSET")
      return { ...base, reason: "IMAGE_MULTIPART_UNSUPPORTED" };
    if (!body.variables || typeof body.variables !== "object" ||
        Array.isArray(body.variables) || Object.keys(body.variables).length !== 1 ||
        !Object.hasOwn(body.variables, "input"))
      return { ...base, reason: "REQUEST_UNVERIFIED" };
    const fields = variableShape(body.variables);
    if (!fields || !requestIdentity(body.variables, target))
      return { ...base, reason: "TARGET_MISMATCH" };
    return { ...base, fields, reason: null };
  } catch { return { reason: target.kind === "IMAGE_ASSET" ?
    "IMAGE_MULTIPART_UNSUPPORTED" : "REQUEST_UNVERIFIED" }; }
  finally { body = null; bytes.fill(0); }
}

function inspectResponse(body, status, target) {
  if (status === 401 || status === 403) return "AUTH_REQUIRED";
  const errors = body?.errors;
  if (Array.isArray(errors) && errors.some(error =>
    /^(?:UNAUTHENTICATED|UNAUTHORIZED|FORBIDDEN)$/i.test(error?.extensions?.code ?? "")))
    return "AUTH_REQUIRED";
  if (status !== 200 || !body || typeof body !== "object" || Array.isArray(body) ||
      errors !== undefined && (!Array.isArray(errors) || errors.length))
    return "RESPONSE_UNVERIFIED";
  const field = target.kind === "UPDATE_PRODUCT" ? "updateProduct" : "createProduct";
  if (!body.data || typeof body.data !== "object" || Array.isArray(body.data) ||
      Object.keys(body.data).length !== 1 || !Object.hasOwn(body.data, field))
    return "RESPONSE_UNVERIFIED";
  const product = body.data[field]?.product;
  if (!product || typeof product !== "object" || Array.isArray(product) ||
      !validId(product.id) || product.id === BLOCKED_REMOTE_ID ||
      product.shopId !== target.shopId || !PRIVATE.has(product.status))
    return "RESPONSE_UNVERIFIED";
  if (target.kind === "UPDATE_PRODUCT") return product.id === target.remoteId ?
    "MATCHED" : "RESPONSE_UNVERIFIED";
  const variants = product.variants;
  return Array.isArray(variants) && variants.length === 1 &&
    variants[0]?.skuCode === target.skuCode &&
    product.id !== target.excludedRemoteId &&
    (product.name === undefined || product.name === target.expectedName) &&
    (product.price === undefined || product.price === target.priceYen) ?
    "MATCHED" : "RESPONSE_UNVERIFIED";
}

function safeSummary(value) {
  const fields = Array.isArray(value?.variableFields) ? value.variableFields : [];
  return { status: value?.status === "MATCHED" && value?.reason === "MATCHED" ?
      "MATCHED" : "UNVERIFIED",
    reason: REASONS.has(value?.reason) ? value.reason : "REQUEST_UNVERIFIED",
    expectedKind: KINDS.has(value?.expectedKind) ? value.expectedKind : null,
    observedKind: KINDS.has(value?.observedKind) ? value.observedKind : null,
    operationName: validName(value?.operationName) ?
      value.operationName : null,
    querySha256: typeof value?.querySha256 === "string" && HASH.test(value.querySha256) ?
      value.querySha256 : null,
    variableFields: fields.length <= 64 && fields.every(item =>
      typeof item?.field === "string" &&
      item.field.split(".").every(part => part === "[]" ||
        FIELDS.has(part.replace(/\[\]$/, ""))) && TYPES.has(item.type)) ?
      fields.map(item => ({ field: item.field, type: item.type })) : [],
    httpStatus: Number.isInteger(value?.httpStatus) && value.httpStatus >= 100 &&
      value.httpStatus <= 599 ? value.httpStatus : null,
    requestTargetMatch: MATCHES.has(value?.requestTargetMatch) ?
      value.requestTargetMatch : "UNOBSERVED",
    responseTargetMatch: MATCHES.has(value?.responseTargetMatch) ?
      value.responseTargetMatch : "UNOBSERVED",
    newRemoteId: value?.status === "MATCHED" && value?.reason === "MATCHED" &&
      value?.expectedKind === "CREATE_PRODUCT" &&
      validId(value.newRemoteId) && value.newRemoteId !== BLOCKED_REMOTE_ID ?
      value.newRemoteId : null };
}

function inFixedShop(page, fixed) {
  try {
    const url = new URL(page.url());
    const root = `/seller/shops/${fixed.shopId}/products`;
    if (fixed.kind === "CREATE_PRODUCT")
      return url.origin === "https://mercari-shops.com" &&
        url.pathname === `${root}/create` && !url.search && !url.hash;
    return url.origin === "https://mercari-shops.com" &&
      (url.pathname === root || url.pathname.startsWith(root + "/"));
  } catch { return false; }
}

/** Passive only. The caller must arm immediately before one normal UI action. */
export function observeBoundedShopsWrite(context, { page, target, timeoutMs = 12000 }) {
  if (typeof context?.on !== "function" || typeof context?.off !== "function" ||
      !page || !validTarget(target) || !Number.isInteger(timeoutMs) ||
      timeoutMs < 1 || timeoutMs > 30000)
    throw Error("Invalid fixed write-observation target");
  const fixed = Object.freeze({ kind: target.kind, shopId: target.shopId,
    remoteId: target.remoteId, inventoryCode: target.inventoryCode,
    skuCode: target.skuCode, excludedRemoteId: target.excludedRemoteId ?? null,
    expectedName: target.expectedName ?? null, priceYen: target.priceYen ?? null });
  const candidates = [];
  const byRequest = new WeakMap();
  let armed = false;
  let ended = false;
  const onRequest = request => {
    if (!armed || ended || candidates.length >= 2 || request.method() !== "POST" ||
        !["fetch", "xhr"].includes(request.resourceType()) ||
        request.url() !== GRAPHQL_URL) return;
    let requestPage;
    try { requestPage = request.frame().page(); } catch { return; }
    if (requestPage !== page || !inFixedShop(page, fixed)) return;
    let inspected;
    try { inspected = inspectRequest(request.postDataBuffer(), fixed); }
    catch { inspected = { reason: "REQUEST_UNVERIFIED" }; }
    if (inspected.ignore) return;
    const entry = { ...inspected, responseReason: null, httpStatus: null,
      done: false, failed: false, responseSeen: false };
    candidates.push(entry);
    byRequest.set(request, entry);
  };
  const onResponse = response => {
    const entry = byRequest.get(response.request());
    if (!entry || ended || entry.done) return;
    if (entry.responseSeen) {
      entry.failed = true;
      entry.responseReason = "RESPONSE_UNVERIFIED";
      entry.done = true;
      return;
    }
    entry.responseSeen = true;
    const status = response.status();
    entry.httpStatus = Number.isInteger(status) ? status : null;
    if (status === 401 || status === 403) {
      entry.responseReason = "AUTH_REQUIRED"; entry.done = true; return;
    }
    Promise.resolve().then(async () => {
      const bytes = await response.body();
      if (ended || entry.failed) return;
      if (!Buffer.isBuffer(bytes) || bytes.length > MAX_BYTES) {
        entry.responseReason = "RESPONSE_UNVERIFIED"; return;
      }
      const copy = Buffer.from(bytes);
      try {
        const body = JSON.parse(copy.toString("utf8"));
        const reason = inspectResponse(body, status, fixed);
        if (!ended && !entry.failed) {
          entry.responseReason = reason;
          if (reason === "MATCHED" && fixed.kind === "CREATE_PRODUCT")
            entry.newRemoteId = body.data.createProduct.product.id;
        }
      } catch {
        if (!ended && !entry.failed) entry.responseReason = "RESPONSE_UNVERIFIED";
      }
      finally { copy.fill(0); }
    }).catch(() => {
      if (!ended && !entry.failed) entry.responseReason = "RESPONSE_UNVERIFIED";
    }).finally(() => { if (!ended) entry.done = true; });
  };
  const onFailed = request => {
    const entry = byRequest.get(request);
    if (entry && !entry.done) {
      entry.failed = true;
      entry.responseReason = "RESPONSE_UNVERIFIED";
      entry.done = true;
    }
  };
  const detach = () => {
    ended = true;
    context.off("request", onRequest);
    context.off("response", onResponse);
    context.off("requestfailed", onFailed);
  };
  context.on("request", onRequest);
  context.on("response", onResponse);
  context.on("requestfailed", onFailed);
  return {
    arm() {
      if (armed || ended) throw Error("Observation cannot be armed again");
      if (!inFixedShop(page, fixed))
        throw Error("Exact shop product page is not open");
      armed = true;
    },
    async finish() {
      if (!armed || ended) throw Error("Observation was not armed");
      const deadline = Date.now() + timeoutMs;
      while (candidates.length < 2 && Date.now() < deadline)
        await new Promise(resolve => setTimeout(resolve, Math.min(20, deadline - Date.now())));
      detach();
      let result;
      if (candidates.length > 1) result = { reason: "MULTIPLE_REQUESTS" };
      else if (candidates.length === 0) result = { reason: "NO_REQUEST" };
      else {
        const entry = candidates[0];
        const reason = entry.reason ?? (entry.done ? entry.responseReason : "TIMEOUT");
        result = { reason, status: reason === "MATCHED" ? "MATCHED" : "UNVERIFIED",
          observedKind: entry.observedKind, operationName: entry.operationName,
          querySha256: entry.querySha256, variableFields: entry.fields,
          httpStatus: entry.httpStatus,
          requestTargetMatch: entry.reason === null ? "MATCH" : "UNOBSERVED",
          responseTargetMatch: reason === "MATCHED" ? "MATCH" : "UNOBSERVED",
          newRemoteId: reason === "MATCHED" ? entry.newRemoteId : null };
      }
      candidates.length = 0;
      return safeSummary({ ...result, expectedKind: fixed.kind });
    },
    stop() {
      if (!ended) detach();
      candidates.length = 0;
      return safeSummary({ reason: "STOPPED", expectedKind: fixed.kind });
    },
  };
}

export const safeWriteContractSummary = safeSummary;

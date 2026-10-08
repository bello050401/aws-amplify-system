import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const MAX_HAR_BYTES = 100 * 1024 * 1024;
const MAX_OUTPUT_ENTRIES = 1_000;
const MAX_OPERATION_BODY_BYTES = 64 * 1024;
const ROOT_DOMAINS = ["mercari-shops.com", "mercari.com", "mercari.jp"];
const EXACT_HOSTS = new Set([
  "mercari-shops.com", "www.mercari-shops.com",
  "api.mercari-shops.com", "mercari.com", "www.mercari.com",
  "jp.mercari.com", "auth.mercari.com", "mercari.jp",
  "www.mercari.jp",
]);
const SAFE_PATH_PARTS = new Set([
  "api", "auth", "callback", "challenge", "confirm", "graphql",
  "login", "logout", "oauth", "products", "refresh", "seller",
  "session", "shops", "signin", "signup", "sms", "token", "v1",
  "v2", "verification", "verify",
]);
const SAFE_REQUEST_HEADERS = new Set([
  "accept", "content-type", "origin", "referer", "x-csrf-token",
  "x-requested-with",
]);
const SAFE_RESPONSE_HEADERS = new Set([
  "content-type", "location", "cache-control", "vary",
]);
const SAFE_MEDIA_TYPES = new Set([
  "application/json", "application/graphql", "application/graphql-response+json",
  "application/x-www-form-urlencoded", "multipart/form-data",
  "text/html", "text/plain",
]);
const SAFE_METHODS = new Set([
  "GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE",
]);
// Only names already reviewed in local read/write observations are emitted.
// Unknown names may contain identifiers, so their raw text is never returned.
const SAFE_GRAPHQL_OPERATIONS = new Set([
  "Self", "GetProductDraft", "CreateProductDraft", "UpdateProductDraft",
  "productDrafts", "createImageAsset",
]);

function mercariHost(hostname) {
  if (typeof hostname !== "string") return null;
  const host = hostname.toLowerCase();
  for (const root of ROOT_DOMAINS) {
    if (host === root || host.endsWith(`.${root}`))
      return EXACT_HOSTS.has(host) ? host : `*.${root}`;
  }
  return null;
}

function safePath(pathname) {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length === 0) return "/";
  return `/${parts.slice(0, 16).map(part => {
    const lower = part.toLowerCase();
    return SAFE_PATH_PARTS.has(lower) ? lower : ":redacted";
  }).join("/")}${parts.length > 16 ? "/:truncated" : ""}`;
}

function safeHeaderNames(headers, allowed) {
  if (!Array.isArray(headers)) return [];
  return [...new Set(headers.map(header =>
    typeof header?.name === "string" ? header.name.toLowerCase() : "")
    .filter(name => allowed.has(name)))].sort();
}

function safeMediaType(headers, fallback) {
  const found = Array.isArray(headers) ? headers.find(header =>
    typeof header?.name === "string" &&
    header.name.toLowerCase() === "content-type")?.value : undefined;
  const value = typeof found === "string" ? found : fallback;
  if (typeof value !== "string") return null;
  const type = value.split(";", 1)[0].trim().toLowerCase();
  return SAFE_MEDIA_TYPES.has(type) ? type : "OTHER";
}

function safeOperationName(request) {
  if (request?.method !== "POST" ||
      typeof request?.postData?.text !== "string" ||
      Buffer.byteLength(request.postData.text, "utf8") > MAX_OPERATION_BODY_BYTES)
    return null;
  try {
    const body = JSON.parse(request.postData.text);
    if (!body || Array.isArray(body) || typeof body !== "object" ||
        typeof body.operationName !== "string") return null;
    return SAFE_GRAPHQL_OPERATIONS.has(body.operationName) ?
      body.operationName : "REDACTED";
  } catch { return null; }
}

/** Pure, read-only projection. No original URL, header value or body is returned. */
export function summarizeMercariHar(har) {
  if (!har || !Array.isArray(har.log?.entries))
    throw Error("INVALID_HAR");
  const entries = [];
  let mercariEntryCount = 0;
  for (const entry of har.log.entries) {
    const request = entry?.request;
    const response = entry?.response;
    let url;
    try { url = new URL(request?.url); }
    catch { continue; }
    if (url.protocol !== "https:") continue;
    const host = mercariHost(url.hostname);
    if (!host) continue;
    mercariEntryCount++;
    if (entries.length >= MAX_OUTPUT_ENTRIES) continue;
    const method = typeof request?.method === "string" &&
      SAFE_METHODS.has(request.method.toUpperCase()) ?
        request.method.toUpperCase() : "OTHER";
    const status = Number.isInteger(response?.status) &&
      response.status >= 100 && response.status <= 599 ?
        response.status : null;
    const path = safePath(url.pathname);
    entries.push({
      order: mercariEntryCount,
      host,
      path,
      method,
      status,
      requestContentType: safeMediaType(request?.headers,
        request?.postData?.mimeType),
      responseContentType: safeMediaType(response?.headers,
        response?.content?.mimeType),
      requestHeaderNames: safeHeaderNames(request?.headers,
        SAFE_REQUEST_HEADERS),
      responseHeaderNames: safeHeaderNames(response?.headers,
        SAFE_RESPONSE_HEADERS),
      graphqlOperationName: path === "/graphql" ?
        safeOperationName(request) : null,
    });
  }
  return { schemaVersion: 1, mercariEntryCount,
    truncated: mercariEntryCount > MAX_OUTPUT_ENTRIES, entries };
}

if (process.argv[1] &&
    pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.length !== 3) {
    process.stderr.write("USAGE: node scripts/summarize-mercari-login-har.mjs <local-har-path>\n");
    process.exitCode = 2;
  } else {
    try {
      const path = process.argv[2];
      if (statSync(path).size > MAX_HAR_BYTES) throw Error("TOO_LARGE");
      const har = JSON.parse(readFileSync(path, "utf8"));
      process.stdout.write(`${JSON.stringify(summarizeMercariHar(har))}\n`);
    } catch {
      // Never include a path, parser error, or HAR content in ordinary logs.
      process.stderr.write("HAR_SUMMARY_FAILED\n");
      process.exitCode = 1;
    }
  }
}

const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const TYPES = new Set(["fetch", "xhr"]);
const PATH_PARTS = new Set(["api", "v1", "v2", "v3", "seller", "shops", "products",
  "product", "items", "item", "inventory", "listings", "listing", "graphql",
  "edit", "search", "stock", "status"]);
const MAX_ENTRIES = 30;

/** Return only fixed vocabulary; URL values, query, headers and bodies never leave this function. */
export function safeShopsTrafficResponse(response) {
  try {
    const request = response.request();
    const method = request.method();
    const type = request.resourceType();
    const status = response.status();
    const url = new URL(response.url());
    if (url.protocol !== "https:" ||
        !(url.hostname === "mercari-shops.com" || url.hostname.endsWith(".mercari-shops.com")) ||
        !METHODS.has(method) || !TYPES.has(type) ||
        !Number.isInteger(status) || status < 100 || status > 599) return null;
    const path = "/" + url.pathname.split("/").filter(Boolean).slice(0, 12)
      .map(part => PATH_PARTS.has(part) ? part : ":value").join("/");
    return { host: url.hostname === "mercari-shops.com" ? "mercari-shops.com" : "*.mercari-shops.com",
      method, type, path, status };
  } catch { return null; }
}

/** Revalidate the callback boundary before displaying even an in-memory summary. */
export function safeShopsTrafficSummary(items) {
  if (!Array.isArray(items)) return [];
  return items.slice(0, MAX_ENTRIES).flatMap(item => {
    if (!item || typeof item !== "object" ||
        !["mercari-shops.com", "*.mercari-shops.com"].includes(item.host) ||
        !METHODS.has(item.method) || !TYPES.has(item.type) ||
        !Number.isInteger(item.status) || item.status < 100 || item.status > 599 ||
        !Number.isInteger(item.count) || item.count < 1 || item.count > 10000 ||
        typeof item.path !== "string" || !item.path.startsWith("/") ||
        (item.path !== "/" && item.path.split("/").slice(1).some(part => part !== ":value" && !PATH_PARTS.has(part)))) return [];
    return [{ host: item.host, method: item.method, type: item.type,
      path: item.path, status: item.status, count: item.count }];
  });
}

/** In-memory aggregate for one normal exact-product browser visit; nothing is logged or persisted. */
export function observeShopsTraffic(context) {
  if (typeof context.on !== "function" || typeof context.off !== "function")
    throw Error("The dedicated browser cannot observe response metadata");
  const entries = new Map();
  const onResponse = response => {
    const safe = safeShopsTrafficResponse(response);
    if (!safe) return;
    const key = JSON.stringify(safe);
    const previous = entries.get(key);
    if (previous) previous.count++;
    else if (entries.size < MAX_ENTRIES) entries.set(key, { ...safe, count: 1 });
  };
  context.on("response", onResponse);
  return {
    snapshot: () => [...entries.values()].map(entry => ({ ...entry })),
    stop: () => context.off("response", onResponse),
  };
}

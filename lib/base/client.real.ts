import { getAccessToken } from "./oauth";
import { BaseApiError, type BaseApiClient } from "./client";
import type { BaseItem, BaseSearchParams, BaseSearchResult } from "./types";

/**
 * Real BASE API client.
 *
 * Endpoint paths and the OAuth flow follow BASE's known, stable public
 * API conventions. This environment could never reach api.thebase.in
 * directly to confirm the exact response field names for items, but a
 * real /1/items response has since been captured via server logs during
 * Phase 1 testing — see docs/NOTES_BASE_API.md for what's confirmed
 * (item_id, title, price, stock, imgN_origin) versus still-unverified
 * (variations, the visible/published field, item_url). `mapItem()` below
 * still checks several plausible field names per value and logs a
 * warning when it has to fall back to an empty default, for whatever
 * remains unconfirmed.
 */
const API_BASE = "https://api.thebase.in/1";

async function baseFetch<T>(path: string, params?: Record<string, string | number>): Promise<T> {
  const token = await getAccessToken();
  const url = new URL(`${API_BASE}${path}`);
  for (const [key, value] of Object.entries(params ?? {})) {
    url.searchParams.set(key, String(value));
  }

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });

  if (!res.ok) {
    throw new BaseApiError(`BASE API ${path} failed: ${await res.text()}`, res.status);
  }

  return (await res.json()) as T;
}

// Loosely typed on purpose — see the module doc comment above.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RawBaseItem = Record<string, any>;

function pick(raw: RawBaseItem, ...keys: string[]): unknown {
  for (const key of keys) {
    if (raw[key] !== undefined && raw[key] !== null) return raw[key];
  }
  return undefined;
}

// Confirmed against a real BASE /1/items response (server logs captured
// during Phase 1 testing — see docs/NOTES_BASE_API.md): images come back
// as flat, numbered fields (img1_origin, img2_origin, …), not an array or
// a nested object. BASE allows up to 20 images per item, so that's the
// upper bound checked; missing/null/empty slots are simply skipped, and
// order is preserved (img1_origin is always the thumbnail used first).
const MAX_ITEM_IMAGES = 20;

function extractImageUrls(raw: RawBaseItem): string[] {
  const numbered: string[] = [];
  for (let i = 1; i <= MAX_ITEM_IMAGES; i++) {
    const value = raw[`img${i}_origin`];
    if (typeof value === "string" && value.trim()) numbered.push(value);
  }
  if (numbered.length > 0) return numbered;

  // Fallback for a shape this environment never actually saw confirmed
  // live (e.g. if a different endpoint/API version ever returns a nested
  // array instead) — kept so mapItem() degrades gracefully rather than
  // silently returning zero images if BASE's shape differs by endpoint.
  const candidate = pick(raw, "images", "img", "imgs", "photos");
  if (Array.isArray(candidate)) {
    return candidate
      .map((img) => {
        if (typeof img === "string") return img;
        if (img && typeof img === "object") {
          return (img.origin ?? img.url ?? img.large ?? img.image_url ?? img.src ?? "") as string;
        }
        return "";
      })
      .filter(Boolean);
  }
  const single = pick(raw, "image_url", "img_url", "thumbnail_url");
  return typeof single === "string" ? [single] : [];
}

function mapItem(raw: RawBaseItem): BaseItem {
  const itemId = String(pick(raw, "item_id", "itemId", "id") ?? "");
  const images = extractImageUrls(raw);
  const price = Number(pick(raw, "price", "item_price") ?? 0);
  const stock = Number(pick(raw, "stock", "item_stock") ?? 0);

  if (!itemId || images.length === 0 || !price) {
    // Dumps the actual raw item, not just its key names — a key name alone
    // ("images") doesn't tell you it's e.g. `{ photo: { origin: "..." } }`
    // instead of an array. This is the fastest path to a correct
    // extractImageUrls()/mapItem() field mapping: capture one of these log
    // lines from the `npm run dev` terminal and the exact shape is right
    // there, no more guessing at plausible field names. See docs/NOTES_BASE_API.md.
    console.warn(
      "[BASE mapItem] unexpected item shape — check docs/NOTES_BASE_API.md and adjust field mapping. Raw item:",
      JSON.stringify(raw).slice(0, 2000),
    );
  }

  // Field names confirmed against BASE's published /items/detail reference
  // (see docs/NOTES_BASE_API.md): variation stock comes back as
  // `variation_stock`, not `stock` — kept `stock` as a fallback in case an
  // older/different response shape ever uses it.
  const rawVariations = pick(raw, "variations", "item_variations");
  const variations = Array.isArray(rawVariations)
    ? rawVariations.map((v: RawBaseItem) => ({
        variationId: String(pick(v, "variation_id", "id") ?? ""),
        label: String(pick(v, "variation", "variation1", "label") ?? ""),
        stock: Number(pick(v, "variation_stock", "stock") ?? 0),
      }))
    : [];

  // Confirmed: `visible` is 1/0 (present) on /items/detail responses.
  const visibleRaw = pick(raw, "visible", "is_visible", "status");
  const isPublished = visibleRaw === undefined ? true : visibleRaw === 1 || visibleRaw === true || visibleRaw === "1";

  return {
    itemId,
    title: String(pick(raw, "title", "item_title") ?? ""),
    price,
    description: String(pick(raw, "detail", "description", "item_detail") ?? ""),
    images: images.map((url) => ({ url })),
    stock,
    variations,
    itemUrl: String(pick(raw, "item_url", "url") ?? ""),
    isPublished,
  };
}

// Short in-memory cache of the full catalog so search-as-you-type doesn't
// re-page through every item on each keystroke. Per server instance —
// fine for a single small-shop admin tool.
let catalogCache: { items: BaseItem[]; fetchedAt: number } | null = null;
const CATALOG_TTL_MS = 60_000;
const MAX_PAGES = 10;
const PAGE_SIZE = 100;

async function fetchFullCatalog(): Promise<BaseItem[]> {
  if (catalogCache && Date.now() - catalogCache.fetchedAt < CATALOG_TTL_MS) {
    return catalogCache.items;
  }

  const items: BaseItem[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await baseFetch<{ items: RawBaseItem[] }>("/items", {
      offset: page * PAGE_SIZE,
      limit: PAGE_SIZE,
    });
    const pageItems = data.items ?? [];
    items.push(...pageItems.map(mapItem));
    if (pageItems.length < PAGE_SIZE) break;
  }

  catalogCache = { items, fetchedAt: Date.now() };
  return items;
}

export class RealBaseApiClient implements BaseApiClient {
  // Deliberately calls only the list endpoint — no per-item /items/detail
  // enrichment here. The list response already carries everything the
  // search screen needs (title/price/stock/images/url), so hydrating each
  // result individually would be pure N+1 for zero benefit; if a `mapItem`
  // warning shows blank images for list items, the fix is a field-mapping
  // correction below, not adding detail calls to this path.
  async search({ query, offset = 0, limit = 30 }: BaseSearchParams): Promise<BaseSearchResult> {
    // BASE's /1/items endpoint is a shop-owner inventory list, not a
    // full-text search engine, so filtering happens here rather than via
    // a server-side keyword param — same approach as the mock client.
    const catalog = await fetchFullCatalog();
    const q = query.trim().toLowerCase();
    const matches = q
      ? catalog.filter(
          (item) => item.title.toLowerCase().includes(q) || item.description.toLowerCase().includes(q),
        )
      : catalog;

    const page = matches.slice(offset, offset + limit);
    return { items: page, hasMore: offset + limit < matches.length, nextOffset: offset + limit };
  }

  /**
   * Only called for flows that genuinely need one full item (URL paste,
   * generating/publishing a feature) — never from search() above.
   */
  async getItem(itemId: string): Promise<BaseItem | null> {
    try {
      // Confirmed against BASE's published API reference: item_id is a URL
      // *path* segment here (`GET /1/items/detail/:item_id`), not a query
      // string parameter — sending it as `?item_id=...` gets back exactly
      // BASE's own "no_item_id" ("item_idは必須です") error, since the path
      // segment BASE actually reads is simply missing. See docs/NOTES_BASE_API.md.
      const data = await baseFetch<{ item: RawBaseItem } | RawBaseItem>(
        `/items/detail/${encodeURIComponent(itemId)}`,
      );
      const raw = "item" in data ? data.item : data;
      return mapItem(raw);
    } catch (err) {
      if (err instanceof BaseApiError && err.status !== undefined && [400, 403, 404].includes(err.status)) {
        // Sold-out / hidden / deleted items can plausibly fail here even
        // though they appeared in the list endpoint moments earlier —
        // skip just this one item (getItems below keeps the rest) rather
        // than treating it as a hard failure.
        console.warn(`[BASE getItem] skipping item_id=${itemId} (status ${err.status}): ${err.message}`);
        return null;
      }
      // Anything else (401 token problem, 5xx, network failure) is a real
      // problem worth surfacing, not silently dropping — see getItems().
      throw err;
    }
  }

  /**
   * Never lets one bad item_id take down the whole batch. A single
   * inaccessible item is expected (see getItem above); a single *broken*
   * one (bad token, BASE outage) still shouldn't erase every other item
   * that fetched fine — Promise.allSettled plus per-item logging means
   * callers (generateFeature, fetchAndCacheItems, …) get everything that
   * succeeded instead of an all-or-nothing failure.
   */
  async getItems(itemIds: string[]): Promise<BaseItem[]> {
    const settled = await Promise.allSettled(itemIds.map((id) => this.getItem(id)));
    const items: BaseItem[] = [];
    settled.forEach((result, index) => {
      if (result.status === "fulfilled") {
        if (result.value) items.push(result.value);
      } else {
        console.error(`[BASE getItems] failed for item_id=${itemIds[index]}:`, result.reason);
      }
    });
    return items;
  }
}

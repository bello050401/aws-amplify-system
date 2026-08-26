import { getAccessToken } from "./oauth";
import { BaseApiError, type BaseApiClient } from "./client";
import type { BaseItem, BaseSearchParams, BaseSearchResult } from "./types";

/**
 * Real BASE API client.
 *
 * Endpoint paths and the OAuth flow follow BASE's known, stable public
 * API conventions. The one part this environment could never verify
 * against a live response (network egress to thebase.in is blocked here
 * — see docs/NOTES_BASE_API.md) is the exact response field names for
 * items, so `mapItem()` below checks several plausible field names per
 * value and logs a warning when it has to fall back to an empty default.
 * If search results come back with missing images/prices, check the
 * server logs for `[BASE mapItem]` warnings first — that will show the
 * true field names to plug in.
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

function extractImageUrls(raw: RawBaseItem): string[] {
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
    console.warn(
      "[BASE mapItem] unexpected item shape — check docs/NOTES_BASE_API.md and adjust field mapping. Raw keys:",
      Object.keys(raw),
    );
  }

  const rawVariations = pick(raw, "variations", "item_variations");
  const variations = Array.isArray(rawVariations)
    ? rawVariations.map((v: RawBaseItem) => ({
        variationId: String(pick(v, "variation_id", "id") ?? ""),
        label: String(pick(v, "variation", "variation1", "label") ?? ""),
        stock: Number(pick(v, "stock") ?? 0),
      }))
    : [];

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

  async getItem(itemId: string): Promise<BaseItem | null> {
    try {
      const data = await baseFetch<{ item: RawBaseItem } | RawBaseItem>("/items/detail", {
        item_id: itemId,
      });
      const raw = "item" in data ? data.item : data;
      return mapItem(raw);
    } catch (err) {
      if (err instanceof BaseApiError && err.status === 404) return null;
      throw err;
    }
  }

  async getItems(itemIds: string[]): Promise<BaseItem[]> {
    const results = await Promise.all(itemIds.map((id) => this.getItem(id)));
    return results.filter((item): item is BaseItem => item !== null);
  }
}

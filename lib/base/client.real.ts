import { getAccessToken } from "./oauth";
import { BaseApiError, type BaseApiClient } from "./client";
import type { BaseItem, BaseSearchParams, BaseSearchResult } from "./types";

/**
 * Real BASE API client.
 *
 * ⚠️ NOT VERIFIED — see docs/NOTES_BASE_API.md. Every path, query param,
 * and response field name below is a best-effort placeholder. Treat this
 * file as a wiring sketch, not a working integration, until it has been
 * checked against real request/response pairs from a working BASE API
 * app. `BASE_USE_MOCK=true` (the default) keeps this file out of the
 * request path so nothing ships against unverified guesses.
 */
const API_BASE = "https://api.thebase.in/1"; // TODO confirm host + version prefix

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

// TODO: replace with the confirmed response shape for the items list/detail
// endpoints once available (see docs/NOTES_BASE_API.md §2–3).
interface RawBaseItem {
  item_id: string;
  title: string;
  price: number;
  detail?: string;
  images?: { origin?: string; url?: string }[];
  stock?: number;
  variations?: { variation_id: string; variation1?: string; stock: number }[];
  item_url?: string;
  visible?: number; // 1 = published, 0 = hidden — TODO confirm field + values
}

function mapItem(raw: RawBaseItem): BaseItem {
  return {
    itemId: raw.item_id,
    title: raw.title,
    price: raw.price,
    description: raw.detail ?? "",
    images: (raw.images ?? []).map((img) => ({ url: img.origin ?? img.url ?? "" })),
    stock: raw.stock ?? 0,
    variations: (raw.variations ?? []).map((v) => ({
      variationId: v.variation_id,
      label: v.variation1 ?? "",
      stock: v.stock,
    })),
    itemUrl: raw.item_url ?? "",
    isPublished: raw.visible === 1,
  };
}

export class RealBaseApiClient implements BaseApiClient {
  async search(params: BaseSearchParams): Promise<BaseSearchResult> {
    // TODO: confirm whether BASE's list endpoint supports a `keyword`
    // query param. If it does not, fetch pages of the full item list
    // (see docs/NOTES_BASE_API.md §4) and filter by title/description
    // here instead — the BaseApiClient interface hides that difference
    // from every caller.
    const data = await baseFetch<{ items: RawBaseItem[]; has_next?: boolean; offset?: number }>(
      "/items", // TODO confirm path
      { keyword: params.query, offset: params.offset ?? 0, limit: params.limit ?? 30 },
    );

    return {
      items: data.items.map(mapItem),
      hasMore: Boolean(data.has_next),
      nextOffset: data.offset,
    };
  }

  async getItem(itemId: string): Promise<BaseItem | null> {
    try {
      const data = await baseFetch<{ item: RawBaseItem }>(`/items/detail`, { item_id: itemId }); // TODO confirm path
      return mapItem(data.item);
    } catch (err) {
      if (err instanceof BaseApiError && err.status === 404) return null;
      throw err;
    }
  }

  async getItems(itemIds: string[]): Promise<BaseItem[]> {
    // Simple sequential fallback until batch-fetch support is confirmed.
    const results = await Promise.all(itemIds.map((id) => this.getItem(id)));
    return results.filter((item): item is BaseItem => item !== null);
  }
}

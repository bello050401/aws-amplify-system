import type { BaseApiClient } from "./client";
import { FIXTURE_ITEMS } from "./fixtures";
import type { BaseItem, BaseSearchParams, BaseSearchResult } from "./types";

/**
 * In-memory mock client, active by default (`BASE_USE_MOCK=true`) so the
 * whole search → select → generate → preview → publish flow can be built
 * and demoed before the real BASE endpoints are confirmed. Search matches
 * against title/description/brand, case-insensitively — the same
 * "search list client-side if BASE's own search is insufficient" fallback
 * the real client documents.
 */
export class MockBaseApiClient implements BaseApiClient {
  async search({ query, offset = 0, limit = 30 }: BaseSearchParams): Promise<BaseSearchResult> {
    const q = query.trim().toLowerCase();
    const matches = q
      ? FIXTURE_ITEMS.filter(
          (item) =>
            item.title.toLowerCase().includes(q) ||
            item.description.toLowerCase().includes(q) ||
            item.brand?.toLowerCase().includes(q),
        )
      : FIXTURE_ITEMS;

    const page = matches.slice(offset, offset + limit);
    return {
      items: page,
      hasMore: offset + limit < matches.length,
      nextOffset: offset + limit,
    };
  }

  async getItem(itemId: string): Promise<BaseItem | null> {
    return FIXTURE_ITEMS.find((i) => i.itemId === itemId) ?? null;
  }

  async getItems(itemIds: string[]): Promise<BaseItem[]> {
    return FIXTURE_ITEMS.filter((i) => itemIds.includes(i.itemId));
  }
}

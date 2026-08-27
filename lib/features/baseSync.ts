import "server-only";
import { adminAuthMode, serverDataClient } from "@/lib/amplify/dataClient";
import { getBaseClient, type BaseItem } from "@/lib/base";

async function upsertCacheRow(item: BaseItem, cachedAt: string) {
  const fields = {
    baseItemId: item.itemId,
    title: item.title,
    price: item.price,
    stock: item.stock,
    isPublished: item.isPublished,
    imageUrls: item.images.map((i) => i.url),
    itemUrl: item.itemUrl,
    brand: item.brand,
    cachedAt,
  };

  // Writing the cache is an admin-only action (this function only ever runs
  // from an authenticated admin flow — see the doc comment below); reading
  // the cache back for the public feature page stays on the default apiKey
  // mode and never touches this file.
  const { data: existing } = await serverDataClient.models.BaseItemCache.get(
    { baseItemId: item.itemId },
    adminAuthMode,
  );

  if (existing) {
    await serverDataClient.models.BaseItemCache.update(fields, adminAuthMode);
  } else {
    await serverDataClient.models.BaseItemCache.create(fields, adminAuthMode);
  }
}

/**
 * Fetches items live from BASE (admin-authenticated context) and writes
 * a snapshot into BaseItemCache so the public feature page can render
 * them without ever needing a BASE access token. Call this everywhere an
 * admin flow already needs live item data (search-result generation,
 * opening the editor, publishing) instead of calling getBaseClient()
 * directly — see the BaseItemCache comment in amplify/data/resource.ts.
 */
export async function fetchAndCacheItems(itemIds: string[]): Promise<BaseItem[]> {
  if (itemIds.length === 0) return [];

  const items = await getBaseClient().getItems(itemIds);
  const now = new Date().toISOString();
  await Promise.all(items.map((item) => upsertCacheRow(item, now)));
  return items;
}

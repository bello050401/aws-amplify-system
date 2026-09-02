import "server-only";
import { adminAuthMode, serverDataClient } from "@/lib/amplify/dataClient";
import { getBaseClient, type BaseItem } from "@/lib/base";
import { unwrapGet, unwrapWriteRequired } from "@/lib/amplify/listAll";

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
  // 「既にあるか」を見て update / create を分ける。ここで取得に失敗して
  // null が返ると **無条件に create へ落ちて同じ商品の行が二重になる**。
  // 失敗は「無い」ではない。
  const existing = unwrapGet(
    await serverDataClient.models.BaseItemCache.get({ baseItemId: item.itemId }, adminAuthMode),
    "BASE商品キャッシュ",
  );

  if (existing) {
    unwrapWriteRequired(await serverDataClient.models.BaseItemCache.update(fields, adminAuthMode), "BASE商品キャッシュ");
  } else {
    unwrapWriteRequired(await serverDataClient.models.BaseItemCache.create(fields, adminAuthMode), "BASE商品キャッシュ");
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

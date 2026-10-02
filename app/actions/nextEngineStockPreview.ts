"use server";

import { getInventoryRole } from "@/lib/amplify/requireInventoryUser";
import { getInventoryDetail } from "@/lib/inventory/queries";
import { getNextEngineMasterSync } from "@/lib/listing/nextEngine/masterSync";
import { withBoundNextEngineRead } from "@/lib/listing/nextEngine/boundRead";
import { readNextEngineStockSnapshot } from "@/lib/listing/nextEngine/stockReadbackClient";
import { compareNextEngineStock, type NextEngineStockComparison } from "@/lib/listing/nextEngine/stockComparison";

export type NextEngineStockPreviewResult =
  | { ok: true; comparison: NextEngineStockComparison | null }
  | { ok: false; message: string };

/** One manual, read-only comparison for an already confirmed BELLO→NE SKU. */
export async function previewNextEngineStockAction(inventoryId: string): Promise<NextEngineStockPreviewResult> {
  if (await getInventoryRole() !== "ADMIN") return { ok: false, message: "管理者のみ確認できます。" };
  try {
    return await withBoundNextEngineRead(async (tokens, persist, binding): Promise<NextEngineStockPreviewResult> => {
      const [item, sync] = await Promise.all([
        getInventoryDetail(inventoryId),
        getNextEngineMasterSync(inventoryId, {
          configuration: async () => binding,
          readTokens: async () => tokens,
        }),
      ]);
      if (!item || !sync || sync.status !== "MASTER_CONFIRMED" || !sync.connectionMatches ||
          !sync.currentMatches || sync.sku !== item.sku) {
        return { ok: false, message: "NEに登録済みの同じ商品を確認できませんでした。" };
      }
      const snapshot = await readNextEngineStockSnapshot(tokens, persist, item.sku);
      return { ok: true, comparison: snapshot ? compareNextEngineStock(item.sku, item.quantity, snapshot) : null };
    });
  } catch {
    return { ok: false, message: "NEの在庫数を確認できませんでした。接続を確認してください。" };
  }
}

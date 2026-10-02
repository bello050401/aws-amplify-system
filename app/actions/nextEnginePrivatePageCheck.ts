"use server";

import { getInventoryRole } from "@/lib/amplify/requireInventoryUser";
import { getInventoryDetail } from "@/lib/inventory/queries";
import { withBoundNextEngineRead } from "@/lib/listing/nextEngine/boundRead";
import { getNextEngineMasterSync } from "@/lib/listing/nextEngine/masterSync";
import { readNextEnginePageVisibility } from "@/lib/listing/nextEngine/pageVisibilityClient";
import type { NextEnginePageVisibility } from "@/lib/listing/nextEngine/pageVisibilityReadback";
import { PRIVATE_MASTER_STAGING_ORIGIN } from "@/lib/listing/nextEngine/privateMasterAcceptance";

const QA_INVENTORY_ID = "5c0587e5-d4f8-4aea-b516-c6a01d9802f0";
const QA_SKU = "B005788";
const STAGING_TOKEN_SECRET_ARN =
  "arn:aws:secretsmanager:us-west-2:203918843421:secret:bello/next-engine-tokens-staging-jAJyao";

export type NextEnginePrivatePageCheckResult =
  | { ok: true; visibility: NextEnginePageVisibility; mercariShopsVisibilityConfirmed: false }
  | { ok: false; message: string };

/** QA-only official page read. A private NE page is not a Mercari Shops listing confirmation. */
export async function checkNextEnginePrivatePageAction(inventoryId: string): Promise<NextEnginePrivatePageCheckResult> {
  if (await getInventoryRole() !== "ADMIN") return { ok: false, message: "管理者のみ確認できます。" };
  if (inventoryId !== QA_INVENTORY_ID || process.env.NEXT_ENGINE_PUBLIC_ORIGIN !== PRIVATE_MASTER_STAGING_ORIGIN ||
      process.env.NEXT_ENGINE_TOKEN_SECRET_ID !== STAGING_TOKEN_SECRET_ARN) {
    return { ok: false, message: "この確認は検証専用商品でのみ利用できます。" };
  }
  try {
    return await withBoundNextEngineRead(async (tokens, persist, binding): Promise<NextEnginePrivatePageCheckResult> => {
      const [item, sync] = await Promise.all([
        getInventoryDetail(inventoryId),
        getNextEngineMasterSync(inventoryId, { configuration: async () => binding, readTokens: async () => tokens }),
      ]);
      if (!item || item.sku !== QA_SKU || item.quantity !== 0 || !sync || sync.sku !== QA_SKU ||
          sync.status !== "MASTER_CONFIRMED" || !sync.connectionMatches || !sync.currentMatches) {
        return { ok: false, message: "検証商品のNE登録状態を確認できませんでした。" };
      }
      const visibility = await readNextEnginePageVisibility(tokens, persist, QA_SKU);
      return { ok: true, visibility, mercariShopsVisibilityConfirmed: false };
    });
  } catch {
    return { ok: false, message: "NEの商品ページを安全に確認できませんでした。接続を確認してください。" };
  }
}

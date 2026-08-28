import { isAmplifyBackendConfigured, ensureAmplifyConfigured } from "@/lib/amplify/config";
import { InventoryService } from "./inventoryService";
import type { DataSource } from "./dataSource";

let cachedService: InventoryService | null = null;

/**
 * PC版・モバイル版で共有する唯一のInventoryServiceインスタンスを返す。
 * amplify_outputs.json がデプロイ済みなら実AWS、そうでなければローカル
 * モック実装を自動選択する。呼び出し側(UI)はどちらか気にしなくてよい。
 */
export function getInventoryService(): InventoryService {
  if (cachedService) return cachedService;

  let ds: DataSource;
  if (isAmplifyBackendConfigured) {
    ensureAmplifyConfigured();
    const { AmplifyDataSource } = require("./amplifyDataSource");
    ds = new AmplifyDataSource();
  } else {
    const { MockDataSource } = require("./mockDataSource");
    ds = new MockDataSource();
  }
  cachedService = new InventoryService(ds);
  return cachedService;
}

export { OptimisticLockError, InsufficientStockError } from "./dataSource";
export { InventoryService } from "./inventoryService";

export type NextEngineStockSnapshot = {
  sku: string;
  quantity: number;
  allocatedQuantity: number;
  freeQuantity: number;
};

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

const nonnegativeInteger = (value: unknown): number | null => {
  if (typeof value !== "string" && typeof value !== "number") return null;
  if (typeof value === "string" && !/^(0|[1-9][0-9]*)$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
};

/** Parse one exact-SKU read. This result is evidence, never an instruction to overwrite BELLO stock. */
export function parseNextEngineStockSnapshot(payload: unknown, sku: string): NextEngineStockSnapshot | null {
  if (!record(payload) || payload.result !== "success" || !Array.isArray(payload.data)) {
    throw new Error("在庫マスタの応答を確認できませんでした。");
  }
  const count = nonnegativeInteger(payload.count);
  if (count === 0 && payload.data.length === 0) return null;
  if (count !== 1 || payload.data.length !== 1 || !record(payload.data[0])) {
    throw new Error("対象商品の在庫を一意に確認できませんでした。");
  }
  const row = payload.data[0];
  if (row.stock_goods_id !== sku || (row.stock_deleted_flag !== "0" && row.stock_deleted_flag !== 0)) {
    throw new Error("対象商品の在庫を確認できませんでした。");
  }
  const quantity = nonnegativeInteger(row.stock_quantity);
  const allocatedQuantity = nonnegativeInteger(row.stock_allocation_quantity);
  const freeQuantity = nonnegativeInteger(row.stock_free_quantity);
  if (quantity === null || allocatedQuantity === null || freeQuantity === null ||
      allocatedQuantity > quantity || freeQuantity > quantity) {
    throw new Error("在庫数を確認できませんでした。");
  }
  return { sku, quantity, allocatedQuantity, freeQuantity };
}

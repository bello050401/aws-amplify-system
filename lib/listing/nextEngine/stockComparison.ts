import type { NextEngineStockSnapshot } from "./stockReadback";

export type NextEngineStockComparison = {
  sku: string;
  belloQuantity: number;
  nextEngineQuantity: number;
  nextEngineAllocatedQuantity: number;
  nextEngineFreeQuantity: number;
  freeQuantityDifference: number;
  applied: false;
};

/** Informational comparison only; neither side is chosen as stock authority here. */
export function compareNextEngineStock(
  sku: string, belloQuantity: number, snapshot: NextEngineStockSnapshot,
): NextEngineStockComparison {
  if (snapshot.sku !== sku || !Number.isSafeInteger(belloQuantity) || belloQuantity < 0) {
    throw new Error("在庫数を安全に比較できませんでした。");
  }
  return {
    sku, belloQuantity,
    nextEngineQuantity: snapshot.quantity,
    nextEngineAllocatedQuantity: snapshot.allocatedQuantity,
    nextEngineFreeQuantity: snapshot.freeQuantity,
    freeQuantityDifference: snapshot.freeQuantity - belloQuantity,
    applied: false,
  };
}

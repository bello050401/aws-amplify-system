import assert from "node:assert/strict";
import { compareNextEngineStock } from "../lib/listing/nextEngine/stockComparison";

const snapshot = { sku: "B005788", quantity: 3, allocatedQuantity: 1, freeQuantity: 2 };
assert.deepEqual(compareNextEngineStock("B005788", 1, snapshot), {
  sku: "B005788", belloQuantity: 1, nextEngineQuantity: 3,
  nextEngineAllocatedQuantity: 1, nextEngineFreeQuantity: 2,
  freeQuantityDifference: 1, applied: false,
});
assert.deepEqual(compareNextEngineStock("B005788", 3, snapshot).freeQuantityDifference, -1);
assert.throws(() => compareNextEngineStock("B005789", 1, snapshot));
assert.throws(() => compareNextEngineStock("B005788", -1, snapshot));
console.log("Next Engine stock comparison: exact SKU, explicit quantities, no mutation.");

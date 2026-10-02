import assert from "node:assert/strict";
import { parseNextEngineStockSnapshot } from "../lib/listing/nextEngine/stockReadback";
import { readNextEngineStockSnapshot } from "../lib/listing/nextEngine/stockReadbackClient";

async function main() {
  const sku = "B005788";
  const row = { stock_goods_id: sku, stock_quantity: "3", stock_allocation_quantity: "1",
    stock_free_quantity: "2", stock_deleted_flag: "0" };
  const success = { result: "success", count: "1", data: [row] };
  assert.deepEqual(parseNextEngineStockSnapshot(success, sku),
    { sku, quantity: 3, allocatedQuantity: 1, freeQuantity: 2 });
  assert.equal(parseNextEngineStockSnapshot({ result: "success", count: "0", data: [] }, sku), null);
  for (const payload of [
    { ...success, count: "2" }, { ...success, data: [row, row] },
    { ...success, data: [{ ...row, stock_goods_id: "B005789" }] },
    { ...success, data: [{ ...row, stock_deleted_flag: "1" }] },
    { ...success, data: [{ ...row, stock_quantity: "-1" }] },
    { ...success, data: [{ ...row, stock_quantity: "NaN" }] },
    { ...success, data: [{ ...row, stock_free_quantity: "4" }] },
    { ...success, data: [{ ...row, stock_allocation_quantity: "4" }] },
  ]) assert.throws(() => parseNextEngineStockSnapshot(payload, sku));

  const tokens = { accessToken: "synthetic-access", refreshToken: "synthetic-refresh" };
  const saved: typeof tokens[] = [];
  let calls = 0;
  const request: typeof fetch = async (url, options) => {
    calls++;
    assert.equal(url, "https://api.next-engine.org/api_v1_master_stock/search");
    assert.equal(options?.method, "POST");
    assert.equal(options?.redirect, "error");
    const body = options?.body as URLSearchParams;
    assert.equal(body.get("stock_goods_id-eq"), sku);
    assert.equal(body.get("limit"), "2");
    assert.equal(body.get("fields"), "stock_goods_id,stock_quantity,stock_allocation_quantity,stock_free_quantity,stock_deleted_flag");
    return Response.json({ ...success, access_token: "rotated-access", refresh_token: "rotated-refresh" });
  };
  assert.deepEqual(await readNextEngineStockSnapshot(tokens, async value => { saved.push(value); }, sku, request),
    { sku, quantity: 3, allocatedQuantity: 1, freeQuantity: 2 });
  assert.deepEqual(saved, [{ accessToken: "rotated-access", refreshToken: "rotated-refresh" }]);
  await assert.rejects(readNextEngineStockSnapshot(tokens, async () => {}, "B005788,B005789", request));
  assert.equal(calls, 1);
  await assert.rejects(readNextEngineStockSnapshot(tokens, async () => { throw new Error("private-value"); },
    sku, request), error => error instanceof Error && !error.message.includes("private-value"));
  await assert.rejects(readNextEngineStockSnapshot(tokens, async () => {}, sku,
    async () => Response.json({ result: "error", count: "0", data: [],
      access_token: "error-access", refresh_token: "error-refresh" }, { status: 400 })));
  await assert.rejects(readNextEngineStockSnapshot(tokens, async () => {}, sku,
    async () => { throw new Error("private-value"); }),
    error => error instanceof Error && !error.message.includes("private-value"));
  console.log("Next Engine stock readback: one exact SKU, read-only, malformed results rejected.");
}
main().catch(error => { console.error(error); process.exitCode = 1; });

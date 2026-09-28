import assert from "node:assert/strict";
import { confirmPrivateTestMaster } from "../lib/listing/nextEngine/masterReadbackClient";

async function main() {
  const sku = "BELLO-NE-TEST-20260928";
  const expected = { sku, title: "合成テスト商品", supplierCode: "SYNTHETIC", cost: 100, price: 300 };
  const row = { goods_id: sku, goods_name: expected.title, goods_supplier_id: expected.supplierCode,
    goods_cost_price: "100", goods_selling_price: "300" };
  const tokens = { accessToken: "synthetic-access", refreshToken: "synthetic-refresh" };
  const saved: typeof tokens[] = [];
  const persist = async (value: typeof tokens) => { saved.push(value); };
  let calls = 0;
  const request: typeof fetch = async (url, options) => {
    calls++;
    assert.equal(url, "https://api.next-engine.org/api_v1_master_goods/search");
    assert.equal(options?.method, "POST");
    assert.equal(options?.redirect, "error");
    const body = options?.body as URLSearchParams;
    assert.equal(body.get("goods_id-eq"), sku);
    assert.equal(body.get("fields"), "goods_id,goods_name,goods_supplier_id,goods_cost_price,goods_selling_price");
    assert.equal(body.get("limit"), "2");
    return Response.json({ result: "success", data: [row],
      access_token: "rotated-access", refresh_token: "rotated-refresh" });
  };
  assert.deepEqual(await confirmPrivateTestMaster(tokens, persist, expected, request),
    { sku, state: "MASTER_CONFIRMED", publicationConfirmed: false });
  assert.deepEqual(saved, [{ accessToken: "rotated-access", refreshToken: "rotated-refresh" }]);
  await assert.rejects(confirmPrivateTestMaster(tokens, persist, { ...expected, sku: "B005730" }, request));
  assert.equal(calls, 1);
  for (const data of [[], [{ ...row, goods_id: "OTHER" }], [{ ...row, goods_name: "違う商品" }],
    [{ ...row, goods_selling_price: "999" }], [{ ...row, goods_cost_price: "999" }],
    [{ ...row, goods_supplier_id: "OTHER" }], [row, row]])
    await assert.rejects(confirmPrivateTestMaster(tokens, persist, expected, async () => Response.json({ result: "success", data })));
  await assert.rejects(confirmPrivateTestMaster(tokens, persist, expected, async () => { throw new Error("synthetic-secret"); }),
    error => error instanceof Error && !error.message.includes("synthetic-secret"));
  console.log("Master readback: exact reserved SKU confirmed without publication claim; bad results rejected.");
}
main().catch(error => { console.error(error); process.exitCode = 1; });

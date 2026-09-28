import assert from "node:assert/strict";
import { confirmPrivateTestMaster } from "../lib/listing/nextEngine/masterReadbackClient";

async function main() {
  const sku = "BELLO-NE-TEST-20260928";
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
    assert.equal(body.get("fields"), "goods_id,goods_name");
    assert.equal(body.get("limit"), "2");
    return Response.json({ result: "success", data: [{ goods_id: sku, goods_name: "合成テスト商品" }],
      access_token: "rotated-access", refresh_token: "rotated-refresh" });
  };
  assert.deepEqual(await confirmPrivateTestMaster(tokens, persist, sku, request),
    { sku, state: "MASTER_CONFIRMED", publicationConfirmed: false });
  assert.deepEqual(saved, [{ accessToken: "rotated-access", refreshToken: "rotated-refresh" }]);
  await assert.rejects(confirmPrivateTestMaster(tokens, persist, "B005730", request));
  assert.equal(calls, 1);
  for (const data of [[], [{ goods_id: "OTHER", goods_name: "合成" }],
    [{ goods_id: sku, goods_name: "合成" }, { goods_id: sku, goods_name: "重複" }]])
    await assert.rejects(confirmPrivateTestMaster(tokens, persist, sku, async () => Response.json({ result: "success", data })));
  await assert.rejects(confirmPrivateTestMaster(tokens, persist, sku, async () => { throw new Error("synthetic-secret"); }),
    error => error instanceof Error && !error.message.includes("synthetic-secret"));
  console.log("Master readback: exact reserved SKU confirmed without publication claim; bad results rejected.");
}
main().catch(error => { console.error(error); process.exitCode = 1; });

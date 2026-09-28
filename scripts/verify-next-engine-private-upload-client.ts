import assert from "node:assert/strict";
import { prepareNextEngineProduct } from "../lib/listing/nextEngine/preparation";
import { enqueuePrivateTestMaster } from "../lib/listing/nextEngine/privateUploadClient";
async function main() {
  const code = "BELLO-NE-TEST-20260928";
  const prepared = prepareNextEngineProduct({ sku: code, title: "合成テスト商品", description: "合成説明", price: 300, supplierCode: "SYNTHETIC" });
  let calls = 0;
  const request: typeof fetch = async (url, options) => {
    calls++;
    assert.equal(url, "https://api.next-engine.org/api_v1_master_goods/upload");
    assert.equal(options?.method, "POST");
    assert.equal(options?.redirect, "error");
    const body = options?.body as URLSearchParams;
    assert.equal(body.get("data_type"), "csv");
    assert.equal(body.get("data"), prepared.csv);
    return Response.json({ result: "success", que_id: "189", access_token: "synthetic-secret" });
  };
  assert.deepEqual(await enqueuePrivateTestMaster("synthetic-token", code, code, prepared, request), { queueId: "189", state: "QUEUED", publicationConfirmed: false });
  await assert.rejects(enqueuePrivateTestMaster("synthetic-token", code, "BELLO-NE-TEST-OTHER", prepared, request));
  await assert.rejects(enqueuePrivateTestMaster("synthetic-token", "B005730", "B005730", prepared, request));
  assert.equal(calls, 1);
  await assert.rejects(enqueuePrivateTestMaster("synthetic-token", code, code, prepared, async () => { throw new Error("synthetic-secret"); }), error => error instanceof Error && !error.message.includes("synthetic-secret"));
  console.log("Private upload: reserved SKU and CSV enforced; queue receipt only; ambiguous failure never retried.");
}
main().catch(error => { console.error(error); process.exitCode = 1; });

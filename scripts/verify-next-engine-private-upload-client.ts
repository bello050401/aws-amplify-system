import assert from "node:assert/strict";
import { prepareNextEngineProduct } from "../lib/listing/nextEngine/preparation";
import { enqueuePrivateTestMaster } from "../lib/listing/nextEngine/privateUploadClient";
async function main() {
  const code = "BELLO-NE-TEST-20260928";
  const prepared = prepareNextEngineProduct({ sku: code, title: "合成テスト商品", description: "合成説明", price: 300, supplierCode: "SYNTHETIC" });
  let calls = 0;
  const tokens = { accessToken: "synthetic-token", refreshToken: "synthetic-refresh" };
  const saved: typeof tokens[] = [];
  const persist = async (value: typeof tokens) => { saved.push(value); };
  const request: typeof fetch = async (url, options) => {
    calls++;
    assert.equal(url, "https://api.next-engine.org/api_v1_master_goods/upload");
    assert.equal(options?.method, "POST");
    assert.equal(options?.redirect, "error");
    const body = options?.body as URLSearchParams;
    assert.equal(body.get("data_type"), "csv");
    assert.equal(body.get("data"), prepared.csv);
    return Response.json({ result: "success", que_id: "189", access_token: "synthetic-new-access", refresh_token: "synthetic-new-refresh" });
  };
  assert.deepEqual(await enqueuePrivateTestMaster(tokens, persist, code, code, prepared, request), { queueId: "189", state: "QUEUED", publicationConfirmed: false });
  assert.deepEqual(saved, [{ accessToken: "synthetic-new-access", refreshToken: "synthetic-new-refresh" }]);
  await assert.rejects(enqueuePrivateTestMaster(tokens, persist, code, "BELLO-NE-TEST-OTHER", prepared, request));
  await assert.rejects(enqueuePrivateTestMaster(tokens, persist, "B005730", "B005730", prepared, request));
  assert.equal(calls, 1);
  await assert.rejects(enqueuePrivateTestMaster(tokens, persist, code, code, prepared, async () => { throw new Error("synthetic-secret"); }), error => error instanceof Error && !error.message.includes("synthetic-secret"));
  await assert.rejects(enqueuePrivateTestMaster(tokens, async () => { throw new Error("storage down"); }, code, code, prepared, request));
  await assert.rejects(enqueuePrivateTestMaster(tokens, persist, code, code, prepared, async () => Response.json({ result: "error", access_token: "error-access", refresh_token: "error-refresh" }))) ;
  assert.deepEqual(saved.at(-1), { accessToken: "error-access", refreshToken: "error-refresh" });
  console.log("Private upload: reserved SKU and CSV enforced; queue receipt only; ambiguous failure never retried.");
}
main().catch(error => { console.error(error); process.exitCode = 1; });

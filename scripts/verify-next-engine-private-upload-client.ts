import assert from "node:assert/strict";
import { prepareNextEngineProduct } from "../lib/listing/nextEngine/preparation";
import { enqueuePrivateTestMaster } from "../lib/listing/nextEngine/privateUploadClient";
async function main() {
  const code = "BELLO-NE-TEST-20260928";
  const prepared = prepareNextEngineProduct({ sku: code, title: "合成テスト商品", description: "合成説明", cost: 100, price: 300, supplierCode: "SYNTHETIC" });
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
    assert.equal(body.get("refresh_token"), "synthetic-refresh");
    assert.equal(body.get("data_type"), "csv");
    assert.equal(body.get("data"), prepared.csv);
    return Response.json({ result: "success", que_id: "189", access_token: "synthetic-new-access", refresh_token: "synthetic-new-refresh" });
  };
  assert.deepEqual(await enqueuePrivateTestMaster(tokens, persist, code, code, prepared, request), { queueId: "189", state: "QUEUED", publicationConfirmed: false });
  assert.deepEqual(saved, [{ accessToken: "synthetic-new-access", refreshToken: "synthetic-new-refresh" }]);
  await assert.rejects(enqueuePrivateTestMaster(tokens, persist, code, "BELLO-NE-TEST-OTHER", prepared, request));
  await assert.rejects(enqueuePrivateTestMaster(tokens, persist, "B005730", "B005730", prepared, request));
  await assert.rejects(enqueuePrivateTestMaster(tokens, persist, "BELLO-NE-TEST-BAD_CODE", "BELLO-NE-TEST-BAD_CODE", prepared, request));
  await assert.rejects(enqueuePrivateTestMaster(tokens, persist, code, code, {
    ...prepared, csv: prepared.csv.replace("syohin_setumei_text", "visible_flg"),
  }, request));
  await assert.rejects(enqueuePrivateTestMaster(tokens, persist, code, code, {
    ...prepared, csv: prepared.csv.replace("合成説明", `合成説明"\n"BELLO-NE-TEST-OTHER","SYNTHETIC","別商品","300","説明`),
  }, request));
  await assert.rejects(enqueuePrivateTestMaster(tokens, persist, code, code, {
    ...prepared, csv: prepared.csv.replace('"合成説明"', '"合成説明","追加列"'),
  }, request));
  await assert.rejects(enqueuePrivateTestMaster(tokens, persist, code, code, {
    ...prepared, csv: prepared.csv.replace('"0","0","100"', '"1","0","100"'),
  }, request));
  await assert.rejects(enqueuePrivateTestMaster(tokens, persist, code, code, {
    ...prepared, csv: prepared.csv.replace('"0","0","100"', '"0","0","999"'),
  }, request));
  await assert.rejects(enqueuePrivateTestMaster(tokens, persist, code, code, {
    ...prepared, csv: prepared.csv.replace('"0","0","100"', '"0","0","0100"'),
  }, request));
  assert.equal(calls, 1);
  const multiline = prepareNextEngineProduct({ sku: code, title: "複数行", description: "一行目\n二行目", cost: 100, price: 300, supplierCode: "SYNTHETIC" });
  assert.deepEqual(await enqueuePrivateTestMaster(tokens, persist, code, code, multiline, async (_url, options) => {
    assert.equal((options?.body as URLSearchParams).get("data"), multiline.csv);
    return Response.json({ result: "success", que_id: "190" });
  }), { queueId: "190", state: "QUEUED", publicationConfirmed: false });
  await assert.rejects(enqueuePrivateTestMaster(tokens, persist, code, code, prepared, async () => { throw new Error("synthetic-secret"); }), error => error instanceof Error && !error.message.includes("synthetic-secret"));
  await assert.rejects(enqueuePrivateTestMaster(tokens, async () => { throw new Error("synthetic-storage-secret"); }, code, code, prepared, request), error =>
    error instanceof Error && error.message.includes("再送信せず") && !error.message.includes("synthetic-storage-secret"));
  await assert.rejects(enqueuePrivateTestMaster(tokens, persist, code, code, prepared, async () => Response.json({ result: "error", access_token: "error-access", refresh_token: "error-refresh" }))) ;
  assert.deepEqual(saved.at(-1), { accessToken: "error-access", refreshToken: "error-refresh" });
  await assert.rejects(enqueuePrivateTestMaster(tokens, persist, code, code, prepared, async () => Response.json({ result: "error", access_token: "http-error-access", refresh_token: "http-error-refresh" }, { status: 400 })));
  assert.deepEqual(saved.at(-1), { accessToken: "http-error-access", refreshToken: "http-error-refresh" });
  console.log("Private upload: reserved SKU and CSV enforced; queue receipt only; ambiguous failure never retried.");
}
main().catch(error => { console.error(error); process.exitCode = 1; });

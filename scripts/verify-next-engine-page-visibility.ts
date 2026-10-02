import assert from "node:assert/strict";
import { parseNextEnginePageVisibility } from "../lib/listing/nextEngine/pageVisibilityReadback";
import { readNextEnginePageVisibility } from "../lib/listing/nextEngine/pageVisibilityClient";

async function main() {
  const sku = "B005788";
  const page = { goods_page_goods_code: sku, goods_page_display_flag: "0" };
  const response = (data: unknown[], count = data.length) => ({ result: "success", count: String(count), data });
  assert.equal(parseNextEnginePageVisibility(response([]), sku), "MISSING");
  assert.equal(parseNextEnginePageVisibility(response([page]), sku), "PRIVATE");
  assert.equal(parseNextEnginePageVisibility(response([{ ...page, goods_page_display_flag: 1 }]), sku), "PUBLIC");
  assert.equal(parseNextEnginePageVisibility(response([{ ...page, goods_page_display_flag: null }]), sku), "UNKNOWN");
  for (const bad of [
    response([page, page]), response([page], 2),
    response([{ ...page, goods_page_goods_code: "B005789" }]),
    { result: "error", count: "1", data: [page] },
  ]) assert.throws(() => parseNextEnginePageVisibility(bad, sku));

  const tokens = { accessToken: "synthetic-access", refreshToken: "synthetic-refresh" };
  const saved: typeof tokens[] = [];
  const request: typeof fetch = async (url, options) => {
    assert.equal(url, "https://api.next-engine.org/api_v1_master_goods_page/search");
    assert.equal(options?.method, "POST");
    assert.equal(options?.redirect, "error");
    const body = options?.body as URLSearchParams;
    assert.equal(body.get("goods_page_goods_code-eq"), sku);
    assert.equal(body.get("fields"), "goods_page_goods_code,goods_page_display_flag");
    assert.equal(body.get("limit"), "2");
    return Response.json({ ...response([page]), access_token: "rotated-a", refresh_token: "rotated-r" });
  };
  assert.equal(await readNextEnginePageVisibility(tokens, async value => { saved.push(value); }, sku, request), "PRIVATE");
  assert.deepEqual(saved, [{ accessToken: "rotated-a", refreshToken: "rotated-r" }]);
  await assert.rejects(readNextEnginePageVisibility(tokens, async () => {}, "B005788,B005789", request));
  await assert.rejects(readNextEnginePageVisibility(tokens, async () => { throw new Error("private-value"); }, sku, request),
    error => error instanceof Error && !error.message.includes("private-value"));
  await assert.rejects(readNextEnginePageVisibility(tokens, async () => {}, sku,
    async () => Response.json({ result: "error", access_token: "x", refresh_token: "y" }, { status: 400 })));
  console.log("Next Engine page visibility: exact SKU, 0 private, 1 public, missing/unknown not private.");
}
main().catch(error => { console.error(error); process.exitCode = 1; });

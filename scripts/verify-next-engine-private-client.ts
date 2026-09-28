import assert from "node:assert/strict";
import { verifyNextEnginePrivateTestPage } from "../lib/listing/nextEngine/privatePageClient";
async function main() {
  const code = "BELLO-NE-TEST-20260928";
  const tokens = { accessToken: "synthetic-token", refreshToken: "synthetic-refresh" };
  const saved: typeof tokens[] = [];
  const persist = async (value: typeof tokens) => { saved.push(value); };
  let calls = 0;
  const fake = (payload: unknown) => (async (url: unknown, options: RequestInit) => {
    calls++;
    assert.equal(url, "https://api.next-engine.org/api_v1_master_goods_page/search");
    assert.equal(options.method, "POST");
    assert.equal(options.cache, "no-store");
    assert.equal(options.redirect, "error");
    const form = options.body as URLSearchParams;
    assert.equal(form.get("refresh_token"), "synthetic-refresh");
    assert.equal(form.get("goods_page_goods_code-eq"), code);
    assert.equal(form.get("limit"), "2");
    return new Response(JSON.stringify(payload), { status: 200 });
  }) as typeof fetch;
  const page = { goods_page_goods_code: code, goods_page_display_flag: "0" };
  assert.deepEqual(await verifyNextEnginePrivateTestPage(tokens, persist, code, fake({ result: "success", data: [page] })), { productCode: code, visibility: "PRIVATE" });
  for (const payload of [null, { result: "redirect" }, { result: "success", data: [] }, { result: "success", data: [page, page] }, { result: "success", data: [{ ...page, goods_page_display_flag: "1" }] }])
    await assert.rejects(verifyNextEnginePrivateTestPage(tokens, persist, code, fake(payload)));
  const before = calls;
  await assert.rejects(verifyNextEnginePrivateTestPage(tokens, persist, "B005730", fake({})));
  assert.equal(calls, before);
  const invalidJson = (async () => new Response("synthetic-sensitive-response", { status: 200 })) as typeof fetch;
  await assert.rejects(verifyNextEnginePrivateTestPage(tokens, persist, code, invalidJson), error =>
    error instanceof Error && !error.message.includes("synthetic-sensitive-response"));
  const networkError = (async () => { throw new Error("synthetic-sensitive-network-detail"); }) as typeof fetch;
  await assert.rejects(verifyNextEnginePrivateTestPage(tokens, persist, code, networkError), error =>
    error instanceof Error && !error.message.includes("synthetic-sensitive-network-detail"));
  await assert.rejects(verifyNextEnginePrivateTestPage(tokens, persist, code, fake({ result: "error", access_token: "new-access", refresh_token: "new-refresh" })));
  assert.deepEqual(saved.at(-1), { accessToken: "new-access", refreshToken: "new-refresh" });
  await assert.rejects(verifyNextEnginePrivateTestPage(tokens, persist, code, (async () => Response.json({ result: "error", access_token: "http-access", refresh_token: "http-refresh" }, { status: 400 })) as typeof fetch));
  assert.deepEqual(saved.at(-1), { accessToken: "http-access", refreshToken: "http-refresh" });
  console.log("Read-only private page client: exact target, ambiguous results and expired auth checks passed.");
}
main().catch(error => { console.error(error); process.exitCode = 1; });

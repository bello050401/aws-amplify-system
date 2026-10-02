import assert from "node:assert/strict";
import { parseNextEngineOrderWindow, validateNextEngineOrderWindow } from "../lib/listing/nextEngine/orderWindow";
import { readNextEngineOrderWindow } from "../lib/listing/nextEngine/orderWindowClient";

async function main() {
  const window = { shopId: "2", from: "2026-10-02 00:00:00", before: "2026-10-03 00:00:00" };
  const row = { receive_order_id: "3001", receive_order_shop_id: "2",
    receive_order_import_date: "2026-10-02 12:34:56", receive_order_order_status_id: "20",
    receive_order_buyer_name: "private-person" };
  const success = { result: "success", count: "1", data: [row] };
  assert.deepEqual(parseNextEngineOrderWindow(success, window),
    [{ orderId: "3001", shopId: "2", importedAt: row.receive_order_import_date, statusId: "20" }]);
  assert.deepEqual(parseNextEngineOrderWindow({ result: "success", count: "0", data: [] }, window), []);
  for (const invalid of [
    { ...window, shopId: "" }, { ...window, shopId: "2,3" },
    { ...window, from: "2026-10-02 99:00:00" },
    { ...window, before: "2026-10-04 00:00:00" },
    { ...window, before: window.from },
  ]) assert.throws(() => validateNextEngineOrderWindow(invalid));
  for (const bad of [
    { ...success, count: "51" }, { ...success, count: "2" },
    { ...success, data: [row, row], count: "2" },
    { ...success, data: [{ ...row, receive_order_shop_id: "3" }] },
    { ...success, data: [{ ...row, receive_order_import_date: window.before }] },
    { ...success, data: [{ ...row, receive_order_id: "0" }] },
  ]) assert.throws(() => parseNextEngineOrderWindow(bad, window));

  const tokens = { accessToken: "synthetic-access", refreshToken: "synthetic-refresh" };
  const saved: typeof tokens[] = [];
  const request: typeof fetch = async (url, options) => {
    assert.equal(url, "https://api.next-engine.org/api_v1_receiveorder_base/search");
    assert.equal(options?.method, "POST");
    assert.equal(options?.redirect, "error");
    const body = options?.body as URLSearchParams;
    assert.equal(body.get("receive_order_shop_id-eq"), "2");
    assert.equal(body.get("receive_order_import_date-gte"), window.from);
    assert.equal(body.get("receive_order_import_date-lt"), window.before);
    assert.equal(body.get("offset"), "0");
    assert.equal(body.get("limit"), "51");
    assert.equal(body.get("fields"),
      "receive_order_id,receive_order_shop_id,receive_order_import_date,receive_order_order_status_id");
    return Response.json({ ...success, access_token: "rotated-access", refresh_token: "rotated-refresh" });
  };
  assert.deepEqual(await readNextEngineOrderWindow(tokens, async value => { saved.push(value); }, window, request),
    [{ orderId: "3001", shopId: "2", importedAt: row.receive_order_import_date, statusId: "20" }]);
  assert.deepEqual(saved, [{ accessToken: "rotated-access", refreshToken: "rotated-refresh" }]);
  const exactlyFifty = Array.from({ length: 50 }, (_, index) => ({ ...row, receive_order_id: String(4000 + index) }));
  const fiftyOne = [...exactlyFifty, { ...row, receive_order_id: "4050" }];
  const slicedResponse: typeof fetch = async (_url, options) => {
    const limit = Number((options?.body as URLSearchParams).get("limit"));
    const selected = fiftyOne.slice(0, limit);
    return Response.json({ result: "success", count: String(selected.length), data: selected });
  };
  assert.equal(parseNextEngineOrderWindow({ result: "success", count: "50", data: exactlyFifty }, window).length, 50);
  await assert.rejects(readNextEngineOrderWindow(tokens, async () => {}, window, slicedResponse));
  await assert.rejects(readNextEngineOrderWindow(tokens, async () => { throw new Error("private-value"); },
    window, request), error => error instanceof Error && !error.message.includes("private-value"));
  await assert.rejects(readNextEngineOrderWindow(tokens, async () => {}, window,
    async () => Response.json({ result: "error", count: "0", data: [],
      access_token: "error-access", refresh_token: "error-refresh" }, { status: 400 })));
  await assert.rejects(readNextEngineOrderWindow(tokens, async () => {}, window,
    async () => { throw new Error("private-value"); }),
    error => error instanceof Error && !error.message.includes("private-value"));
  console.log("Next Engine order window: scoped, complete, deduplicated, no personal fields.");
}
main().catch(error => { console.error(error); process.exitCode = 1; });

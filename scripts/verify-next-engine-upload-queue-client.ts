import assert from "node:assert/strict";
import { checkGoodsUploadQueue } from "../lib/listing/nextEngine/uploadQueueClient";
async function main() {
  let calls = 0;
  const tokens = { accessToken: "synthetic-token", refreshToken: "synthetic-refresh" };
  const saved: typeof tokens[] = [];
  const persist = async (value: typeof tokens) => { saved.push(value); };
  const request: typeof fetch = async (url, options) => {
    calls++;
    assert.equal(url, "https://api.next-engine.org/api_v1_system_que/search");
    assert.equal(options?.redirect, "error");
    assert.equal(options?.cache, "no-store");
    assert.equal(options?.method, "POST");
    const body = options?.body as URLSearchParams;
    assert.equal(body.get("que_id-eq"), "189");
    assert.equal(body.get("limit"), "2");
    return Response.json({ result: "success", data: [{ que_id: "189", que_method_name: "SYOHIN_KIHON_CSV", que_status_id: "1" }] });
  };
  assert.deepEqual(await checkGoodsUploadQueue(tokens, persist, "189", request), { queueId: "189", state: "PROCESSING", publicationConfirmed: false });
  await assert.rejects(checkGoodsUploadQueue(tokens, persist, "invalid", request));
  await assert.rejects(checkGoodsUploadQueue({ ...tokens, accessToken: "" }, persist, "189", request));
  assert.equal(calls, 1);
  await assert.rejects(checkGoodsUploadQueue(tokens, persist, "189", async () => { throw new Error("synthetic-secret"); }), error => error instanceof Error && !error.message.includes("synthetic-secret"));
  await assert.rejects(checkGoodsUploadQueue(tokens, persist, "189", async () => Response.json({ result: "error", access_token: "queue-access", refresh_token: "queue-refresh" }, { status: 400 })));
  assert.deepEqual(saved.at(-1), { accessToken: "queue-access", refreshToken: "queue-refresh" });
  console.log("Queue client: one scoped read, no retries, invalid inputs blocked, errors redacted.");
}
main().catch(error => { console.error(error); process.exitCode = 1; });

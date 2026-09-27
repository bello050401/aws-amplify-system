import assert from "node:assert/strict";
import { parseGoodsUploadQueue } from "../lib/listing/nextEngine/uploadQueue";
const row = { que_id: "189", que_method_name: "SYOHIN_KIHON_CSV", que_status_id: "2", que_message: "synthetic-private-detail" };
const response = (record: unknown) => ({ result: "success", data: [record], access_token: "synthetic-secret" });
for (const [status, state] of [[0, "WAITING"], [1, "PROCESSING"], [2, "MASTER_APPLIED"], [-1, "FAILED"]] as const)
  for (const value of [status, String(status)])
    assert.deepEqual(parseGoodsUploadQueue(response({ ...row, que_status_id: value }), "189"), { queueId: "189", state, publicationConfirmed: false });
for (const value of [null, {}, { result: "success", data: [] }, { result: "success", data: [row, row] },
  response({ ...row, que_id: "190" }), response({ ...row, que_method_name: "OTHER" }),
  ...[true, null, " 2", "3", undefined].map(que_status_id => response({ ...row, que_status_id }))])
  assert.throws(() => parseGoodsUploadQueue(value, "189"));
console.log("Queue parser: exact receipt and goods operation required; completed master is never published.");

import assert from "node:assert/strict";
import { parseNextEngineUploadReceipt } from "../lib/listing/nextEngine/uploadReceipt";
assert.deepEqual(parseNextEngineUploadReceipt({ result: "success", que_id: "189", access_token: "synthetic-secret", message: "synthetic-detail" }), {
  queueId: "189", state: "QUEUED", publicationConfirmed: false,
});
for (const value of [null, {}, { result: "redirect", que_id: "189" }, { result: "error", que_id: "189" },
  ...[undefined, null, 189, "", "0", "-1", " 189", "189x"].map(que_id => ({ result: "success", que_id }))])
  assert.throws(() => parseNextEngineUploadReceipt(value));
console.log("Upload receipt: acceptance remains queued; invalid IDs rejected; credentials omitted.");

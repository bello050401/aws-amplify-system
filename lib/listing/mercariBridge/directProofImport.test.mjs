import assert from "node:assert/strict";
import { test } from "node:test";
import { directProofReportFromExport } from "./directProofImport.ts";

const requestId = "a".repeat(64);
const attemptId = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const proof = { schemaVersion: 1, kind: "BELLO_PINNED_DIRECT_READ_PROOF",
  requestId, attemptId, accountReference: "shop-one",
  remoteId: "2JXePE4ke8UCBTj6mxc4cf", inventoryCode: "B005795",
  status: "DIRECT_HTTP_READ_CONFIRMED", reasonCode: "PINNED_HTTP_200_MATCHED",
  listingConfirmed: false };
const dispatch = { requestId, operation: "READ_EXISTING", accountReference: "shop-one",
  remoteId: proof.remoteId, inventoryCode: proof.inventoryCode };

test("pinned proof export forms only the bounded result accepted by BELLO", () => {
  assert.deepEqual(directProofReportFromExport(proof, dispatch), {
    requestId, attemptId, accountReference: "shop-one", remoteId: proof.remoteId,
    status: "DIRECT_HTTP_READ_CONFIRMED", comparison: null,
    reasonCode: "PINNED_HTTP_200_MATCHED",
  });
});

test("proof import rejects another request, target, outcome, or extra fields", () => {
  for (const invalid of [
    { ...proof, requestId: "b".repeat(64) },
    { ...proof, remoteId: "another" },
    { ...proof, inventoryCode: "OTHER" },
    { ...proof, listingConfirmed: true },
    { ...proof, status: "CORE_FIELDS_MATCH" },
    { ...proof, secret: "must-not-send" },
  ]) assert.throws(() => directProofReportFromExport(invalid, dispatch));
  assert.throws(() => directProofReportFromExport(proof, { ...dispatch, accountReference: "other" }));
});

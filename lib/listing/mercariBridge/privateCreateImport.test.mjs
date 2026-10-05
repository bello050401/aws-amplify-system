import assert from "node:assert/strict";
import { test } from "node:test";
import { privateCreateExportForUpload } from "./privateCreateImport.ts";

const claim = { schemaVersion: 1, kind: "BELLO_PRIVATE_CREATE_CLAIM",
  attemptId: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
  claimedAt: "2026-10-05T13:30:00.000Z",
  inventoryId: "c9ee4ea7-070f-491c-bd4c-c1547cb73436",
  inventoryCode: "B005757", shopId: "evkhihBFFNn5hukMS9s36H",
  skuCode: "B005757-TEST-20261004-caf445ac6e676343",
  priceYen: 98000, listingConfirmed: false };
const result = { ...claim, kind: "BELLO_PRIVATE_CREATE_UI_ATTEMPT",
  outcome: "UNVERIFIED", reasonCode: "NETWORK_NOT_OBSERVED" };

test("only the pinned, bounded local claim and UI-unverified result may be sent", () => {
  assert.deepEqual(privateCreateExportForUpload(claim, claim.kind), claim);
  assert.deepEqual(privateCreateExportForUpload(result, result.kind, claim.attemptId), result);
  const autosave = { ...result, reasonCode: "DRAFT_AUTOSAVE_UI_OBSERVED" };
  assert.deepEqual(privateCreateExportForUpload(autosave, autosave.kind,
    claim.attemptId), autosave);
  for (const invalid of [
    { ...claim, shopId: "other" }, { ...claim, priceYen: 26500 },
    { ...claim, listingConfirmed: true }, { ...claim, secret: "do-not-send" },
    { ...result, outcome: "MATCHED" }, { ...result, reasonCode: "MATCHED" },
    { ...result, remoteId: "product" },
  ]) assert.throws(() => privateCreateExportForUpload(invalid, invalid.kind));
  assert.throws(() => privateCreateExportForUpload(result, result.kind,
    "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb"));
});

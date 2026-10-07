import assert from "node:assert/strict";
import test from "node:test";
import { planVisibilityTransition } from "../src/visibilityTransitionPlan.mjs";

const shopId = "evkhihBFFNn5hukMS9s36H";
const target = { shopId, inventoryId: "bd4850de-9156-4890-a821-cae75da5c8f7",
  remoteId: "newOwnedProduct123", title: "An exact owned product",
  skuCode: "B009999", visibilityPolicy: "PUBLIC_ALLOWED" };
const publicRead = { kind: "OBSERVED", shopId,
  remoteId: target.remoteId, title: target.title, visibility: "PUBLIC" };
const privateRead = { ...publicRead, visibility: "PRIVATE" };
const stopProof = { kind: "STOP_VERIFIED", shopId,
  remoteId: target.remoteId, title: target.title, resultingVisibility: "PRIVATE" };

test("stop needs an owned active record and an exact public list readback", () => {
  const listing = { status: "ACTIVE", externalListingId: target.remoteId };
  assert.deepEqual(planVisibilityTransition({ action: "STOP", target,
    listing, readback: publicRead }), { kind: "READY", action: "STOP",
    remoteId: target.remoteId, expectedBefore: "PUBLIC",
    expectedAfter: "PRIVATE", saveLabel: "非公開で保存する" });
  for (const readback of [null, privateRead, { ...publicRead, remoteId: "other" },
    { ...publicRead, title: "other" }])
    assert.deepEqual(planVisibilityTransition({ action: "STOP", target,
      listing, readback }), { kind: "BLOCKED" });
  assert.deepEqual(planVisibilityTransition({ action: "STOP", target,
    listing: { status: "PAUSED", externalListingId: target.remoteId },
    readback: publicRead }), { kind: "BLOCKED" });
});

test("relist needs the same product's verified stop and public permission", () => {
  assert.deepEqual(planVisibilityTransition({ action: "RELIST", target,
    readback: privateRead, stopProof }), { kind: "READY", action: "RELIST",
    remoteId: target.remoteId, expectedBefore: "PRIVATE",
    expectedAfter: "PUBLIC", saveLabel: "公開する" });
  for (const proof of [null, { ...stopProof, remoteId: "other" },
    { ...stopProof, resultingVisibility: "UNKNOWN" }])
    assert.deepEqual(planVisibilityTransition({ action: "RELIST", target,
      readback: privateRead, stopProof: proof }), { kind: "BLOCKED" });
  assert.deepEqual(planVisibilityTransition({ action: "RELIST",
    target: { ...target, visibilityPolicy: "PRIVATE_ONLY" },
    readback: privateRead, stopProof }), { kind: "BLOCKED" });
});

test("both private test inventories and protected public IDs cannot be transitioned", () => {
  const protectedTarget = { ...target,
    inventoryId: "dd273c1e-9b2a-4013-acc6-c445a481fab8",
    remoteId: "2JWp7EJx6aqKfn6dTXc5Q9" };
  const protectedRead = { ...publicRead, remoteId: protectedTarget.remoteId };
  assert.deepEqual(planVisibilityTransition({ action: "STOP", target: protectedTarget,
    readback: protectedRead,
    listing: { status: "ACTIVE", externalListingId: protectedTarget.remoteId } }),
  { kind: "BLOCKED" });
  const newPrivateTarget = { ...target,
    inventoryId: protectedTarget.inventoryId };
  assert.deepEqual(planVisibilityTransition({ action: "RELIST", target: newPrivateTarget,
    readback: privateRead, stopProof }), { kind: "BLOCKED" });
  for (const inventoryId of [protectedTarget.inventoryId.toUpperCase(),
    "Dd273c1e-9b2a-4013-acc6-c445a481fab8",
    [protectedTarget.inventoryId],
    "5b0f3587-cbbb-4c09-ae78-595b2b3e353f",
    "5B0F3587-CBBB-4C09-AE78-595B2B3E353F",
    ["5b0f3587-cbbb-4c09-ae78-595b2b3e353f"]]) {
    assert.deepEqual(planVisibilityTransition({ action: "RELIST",
      target: { ...newPrivateTarget, inventoryId }, readback: privateRead,
      stopProof }), { kind: "BLOCKED" });
    assert.deepEqual(planVisibilityTransition({ action: "STOP",
      target: { ...newPrivateTarget, inventoryId }, readback: publicRead,
      listing: { status: "ACTIVE", externalListingId: target.remoteId } }),
    { kind: "BLOCKED" });
  }
  for (const remoteId of ["2JWp7EJx6aqKfn6dTXc5Q9", "2JToDtSgGowzUwnwe9hgHU"]) {
    assert.deepEqual(planVisibilityTransition({ action: "STOP",
      target: { ...target, remoteId },
      readback: { ...publicRead, remoteId },
      listing: { status: "ACTIVE", externalListingId: remoteId } }),
    { kind: "BLOCKED" });
  }
  for (const skuCode of ["B005659", "B005413",
    "TEST_B005413_B63EF3F86211FFE0F890D81E"])
    assert.deepEqual(planVisibilityTransition({ action: "RELIST",
      target: { ...target, skuCode }, readback: privateRead, stopProof }),
    { kind: "BLOCKED" });
});

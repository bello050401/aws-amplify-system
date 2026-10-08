import assert from "node:assert/strict";
import test from "node:test";
import { pcVisibilityControl, pinnedPublicProofForTarget,
  pcTargetKey } from "./lifecyclePcState.ts";

test("the BELLO control moves from verification to stop only with exact public proof", () => {
  for (const status of ["UNREAD", "PENDING"])
    assert.deepEqual(pcVisibilityControl(true, status, false), {
      action: "STOP", enabled: true,
      label: "既存Shops商品の確認ジョブをPCへ渡す",
    });
  assert.deepEqual(pcVisibilityControl(true, "PUBLIC_VERIFIED", true), {
    action: "STOP", enabled: true, label: "出品停止",
  });
  assert.deepEqual(pcVisibilityControl(true, "PUBLIC_VERIFIED", false), {
    action: "STOP", enabled: false, label: "Shops公開状態の確認待ち",
  });
  assert.deepEqual(pcVisibilityControl(true, "RELIST_VERIFIED", false), {
    action: "STOP", enabled: false, label: "Shops公開状態の確認待ち",
  });
});

test("a verified stop switches the sole control to 出品 without enabling relist", () => {
  assert.deepEqual(pcVisibilityControl(true, "STOP_VERIFIED", false), {
    action: "RELIST", enabled: false, label: "出品",
  });
  assert.deepEqual(pcVisibilityControl(true, "UNKNOWN", true), {
    action: null, enabled: false, label: "Shops側の結果確認待ち",
  });
  assert.deepEqual(pcVisibilityControl(false, "PUBLIC_VERIFIED", true), {
    action: null, enabled: false, label: "Shops公開状態の確認待ち",
  });
});

test("a public proof belongs only to the current inventory and Shops product", () => {
  const inventoryId = "2c53f36a-7a60-4e34-801d-8abc24f6cfc0";
  const remoteId = "product-123";
  const proof = { inventoryId, remoteId, observedAt: "2026-10-08T10:00:00.000Z" };
  const record = { key: pcTargetKey(inventoryId, remoteId),
    status: "PUBLIC_VERIFIED", proof };
  assert.deepEqual(pinnedPublicProofForTarget(record, inventoryId, remoteId), proof);
  assert.equal(pinnedPublicProofForTarget(record, inventoryId, "another-product"), null);
  assert.equal(pinnedPublicProofForTarget(record,
    "00000000-0000-4000-8000-000000000000", remoteId), null);
  assert.equal(pinnedPublicProofForTarget({ ...record, status: "STOP_VERIFIED" },
    inventoryId, remoteId), null);
});

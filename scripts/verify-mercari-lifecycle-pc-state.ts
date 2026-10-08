import assert from "node:assert/strict";
import { pcTargetKey, pinnedPublicProofForTarget,
  samePcTargetEpoch } from
  "../lib/listing/mercariBridge/lifecyclePcState";

const inventoryId = "2c53f36a-7a60-4e34-801d-8abc24f6cfc0";
const a = pcTargetKey(inventoryId, "A");
const b = pcTargetKey(inventoryId, "B");
const record = { key: a, status: "PUBLIC_VERIFIED",
  proof: { inventoryId, remoteId: "A", observedAt: "2026-10-08T00:00:00.000Z" } };
assert.equal(pinnedPublicProofForTarget(record, inventoryId, "A")?.remoteId, "A");
assert.equal(pinnedPublicProofForTarget(record, inventoryId, "B"), null,
  "A proof cannot enable B's STOP handoff or public badge");
assert.equal(pinnedPublicProofForTarget({ ...record, key: b }, inventoryId, "B"), null,
  "Changing only the state key cannot rebind an old proof");
assert.equal(pinnedPublicProofForTarget(record, "different-inventory", "A"), null);

const oldRequest = { key: a, value: 0 };
assert.equal(samePcTargetEpoch({ key: b, value: 1 }, oldRequest), false,
  "a delayed A response is discarded after A to B");
assert.equal(samePcTargetEpoch({ key: a, value: 2 }, oldRequest), false,
  "a delayed A response is discarded after A to B to A");
assert.equal(samePcTargetEpoch({ key: a, value: 0 }, oldRequest), true);
process.stdout.write("Mercari lifecycle PC target isolation verified\n");

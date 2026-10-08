import assert from "node:assert/strict";
import { pcTargetKey, pcRecordCurrent, pcStopJobHandoffEnabled,
  pinnedPublicProofForTarget,
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
const oldBusy = { key: a, epoch: 0, value: true };
assert.equal(pcRecordCurrent(oldBusy, { key: b, value: 1 }), false);
assert.equal(pcRecordCurrent(oldBusy, { key: a, value: 2 }), false,
  "A's old busy state must not survive A to B to A");
assert.equal(pcRecordCurrent({ key: a, epoch: 2 },
  { key: a, value: 2 }), true);
assert.equal(pcStopJobHandoffEnabled(true, "UNREAD", false), true,
  "first read-only confirmation job must be available without public proof");
assert.equal(pcStopJobHandoffEnabled(true, "PUBLIC_VERIFIED", false), false,
  "a STOP handoff needs the current target's public proof");
assert.equal(pcStopJobHandoffEnabled(true, "PUBLIC_VERIFIED", true), true);
process.stdout.write("Mercari lifecycle PC target isolation verified\n");

import assert from "node:assert/strict";
import { planScheduledZaicoDelta } from "../lib/inventory/scheduledZaicoDelta";

const baseline = "2026-09-23T00:00:00.000Z";
const retries = JSON.stringify({ ids: ["previous-failure"], trusted: true });
assert.equal(planScheduledZaicoDelta(null), null);
assert.equal(planScheduledZaicoDelta({ status: "RUNNING", lastSuccessfulSyncAt: baseline, failedSourceIds: retries }), null);
assert.equal(planScheduledZaicoDelta({ status: "COMPLETED", failedSourceIds: retries }), null);
assert.equal(planScheduledZaicoDelta({ status: "COMPLETED", lastSuccessfulSyncAt: baseline, failedSourceIds: "[]" }), null);
assert.deepEqual(planScheduledZaicoDelta({ status: "COMPLETED", lastSuccessfulSyncAt: baseline, failedSourceIds: retries }), {
  syncSince: "2026-09-22T23:55:00.000Z",
  failedSourceIds: retries,
});
console.log("scheduled ZAICO delta: 5 cases passed");

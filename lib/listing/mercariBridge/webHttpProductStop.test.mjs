import test from "node:test";
import assert from "node:assert/strict";
import { WEB_HTTP_SHOP_ID } from "./webHttpDraftJob.ts";
import { stopObservedWebHttpProductOnce, reconcileObservedWebHttpProductStop } from
  "./webHttpProductStop.ts";

import { inventoryId, admin, binding, fixture } from "./webHttpProductLifecycle.fixture.mjs";
const run = f => stopObservedWebHttpProductOnce(inventoryId, admin, f.ports, f.clock);
const reconcile = (f, requestId) => reconcileObservedWebHttpProductStop(requestId, admin, f.ports, f.clock);

test("HTTPS stop is stored only after a matching readback; preserves quantity and images", async () => {
  const f = fixture();
  const output = await run(f);
  assert.equal(output.status, "STOP_VERIFIED");
  assert.equal(output.stopConfirmed, true);
  assert.equal(f.sends().length, 1);
  assert.equal(f.attempts.get(output.requestId).status, "PRODUCT_STOP_VERIFIED");
  assert.deepEqual(f.sends()[0].variables.input.assetIds, ["Front", "Back"]);
  assert.equal(f.sends()[0].variables.input.variants[0].quantity, 1);
  assert.equal(f.sends()[0].variables.input.productSnapshotId, "revision-1");
  assert.equal(f.sends()[0].variables.input.variants[0].stockSnapshotId, "stock-1");
  assert.equal(JSON.stringify(output).includes("fixture-secret"), false);
  assert.equal((await run(f)).status, "ALREADY_STOPPED");
  assert.equal(f.sends().length, 1);
});

test("lost mutation response is resolved by readback without a second update", async () => {
  const f = fixture(); f.state.timeoutAfterCommit = true;
  const output = await run(f);
  assert.equal(output.status, "STOP_VERIFIED");
  assert.equal((await reconcile(f, output.requestId)).status, "STOP_VERIFIED");
  assert.equal(f.sends().length, 1);
});

test("unknown result retains product guard across changed revisions and process-style resume", async () => {
  const f = fixture(); f.state.timeoutBeforeCommit = true;
  const output = await run(f);
  assert.equal(output.status, "RESULT_UNKNOWN_NO_RESEND");
  f.product().snapshotId = "external-revision";
  f.advance(120_000);
  const retried = await run(f);
  assert.equal(retried.requestId, output.requestId);
  assert.equal(retried.allowAutomaticResend, false);
  assert.equal(f.sends().length, 1);
});

test("read failure after ACK never confirms stopping or deletion; later read resumes", async () => {
  const f = fixture(); f.state.readFailsAfterSend = true;
  const output = await run(f);
  assert.equal(output.status, "RESULT_UNKNOWN_NO_RESEND");
  assert.equal(output.stopConfirmed, false);
  f.state.readFailsAfterSend = false;
  assert.equal((await reconcile(f, output.requestId)).status, "STOP_VERIFIED");
  assert.equal(f.sends().length, 1);
});

test("authentication expiry after send waits for reauthentication and then reads only", async () => {
  const f = fixture(); f.state.authAfterSend = true;
  const output = await run(f);
  assert.equal(output.status, "AUTH_REQUIRED");
  assert.equal(output.stopConfirmed, false);
  f.state.authAfterSend = false;
  assert.equal((await reconcile(f, output.requestId)).status, "STOP_VERIFIED");
  assert.equal(f.sends().length, 1);
});

test("durable save failure does not report success; reconciliation saves without resending", async () => {
  const f = fixture(); f.state.saveFail = true;
  const output = await run(f);
  assert.equal(output.status, "STORAGE_UNAVAILABLE");
  assert.equal(output.stopConfirmed, false);
  f.state.saveFail = false;
  assert.equal((await reconcile(f, output.requestId)).status, "STOP_VERIFIED");
  assert.equal(f.sends().length, 1);
});

test("changed quantity before claim is never overwritten; expired unclaimed reservation can be released", async () => {
  const f = fixture(); f.state.changeBeforeClaim = true;
  const output = await run(f);
  assert.equal(output.status, "TARGET_CHANGED");
  assert.equal(f.sends().length, 0);
  f.advance(61_000);
  await reconcile(f, output.requestId);
  assert.equal(f.attempts.get(output.requestId).status, "CANCELLED_NO_SEND");
  f.state.changeBeforeClaim = false;
  assert.equal((await run(f)).status, "STOP_VERIFIED");
  assert.equal(f.sends().length, 1);
});

test("expiry during the durable claim never sends", async () => {
  const f = fixture(); f.state.claimExpiry = true;
  assert.equal((await run(f)).status, "RESULT_UNKNOWN_NO_RESEND");
  assert.equal(f.sends().length, 0);
});

test("already stopped, missing link, unknown expiry and rejected validation never update", async () => {
  for (const modify of [
    f => { f.product().status.id = "STATUS_UNOPENED"; },
    f => { f.ports.readBinding = async () => null; },
    f => { f.ports.session.expiresAtMs = null; },
    f => { f.state.validationFail = true; },
    f => { f.product().variants[0].skuCode = "ANOTHER_ITEM"; },
  ]) {
    const f = fixture(); modify(f); await run(f);
    assert.equal(f.sends().length, 0);
    assert.equal(f.attempts.size, 0);
  }
});

test("concurrent clicks perform at most one mutation", async () => {
  const f = fixture();
  await Promise.all([run(f), run(f)]);
  assert.equal(f.sends().length, 1);
});

test("reopened product respects shared interval and uses its new snapshots", async () => {
  const f = fixture(); await run(f);
  f.product().status.id = "STATUS_OPENED"; f.product().snapshotId = "revision-3";
  assert.equal((await run(f)).status, "WAIT_INTERVAL");
  f.advance(61_000);
  assert.equal((await run(f)).status, "STOP_VERIFIED");
  assert.equal(f.sends().length, 2);
  assert.equal(f.sends()[1].variables.input.productSnapshotId, "revision-3");
});

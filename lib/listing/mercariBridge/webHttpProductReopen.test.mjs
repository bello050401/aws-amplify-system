import test from "node:test";
import assert from "node:assert/strict";
import { fixture, binding, inventoryId, admin } from "./webHttpProductLifecycle.fixture.mjs";
import { reopenObservedWebHttpProduct } from "./webHttpProductReopen.ts";
import { stopObservedWebHttpProductOnce } from "./webHttpProductStop.ts";
import { reconcilePendingProductVisibility } from "./webHttpProductReconcile.ts";
import { openMercariWebHttpCookieReadOnly } from "./webHttpReadOnlyClient.ts";
const run = (f, digest = null) => reopenObservedWebHttpProduct(inventoryId, admin, digest, f.ports, f.clock);
const stopped = () => { const f = fixture(); f.product().status.id = "STATUS_UNOPENED"; return f; };
async function refresh(f) {
  const { client } = await openMercariWebHttpCookieReadOnly(f.ports.session, { fetchPort: f.ports.fetchPort, clock: f.clock });
  await client.verifyTargetShop();
  const { product } = await client.readProduct(binding.remoteProductId);
  return reconcilePendingProductVisibility(binding, product, admin, f.repo, f.clock);
}
test("reopen requires exact confirmation and reuses the same product ID", async () => {
  const f = stopped(), review = await run(f);
  assert.equal(review.status, "READY_FOR_CONFIRMATION"); assert.equal(f.sends().length, 0);
  assert.equal((await run(f, "a".repeat(64))).status, "CONFIRMATION_CHANGED");
  assert.equal((await run(f, review.preview.digest)).status, "PUBLISHED");
  assert.equal(f.sends()[0].variables.input.id, binding.remoteProductId);
  assert.equal(f.sends()[0].variables.input.status, "STATUS_OPENED");
  assert.equal(f.requests.some(r => r.operationName === "CreateProduct"), false);
  assert.equal((await run(f)).status, "EXISTING_PRODUCT"); assert.equal(f.sends().length, 1);
});
test("stop then reopen shares the 30-second minimum send interval", async () => {
  const f = fixture(); await stopObservedWebHttpProductOnce(inventoryId, admin, f.ports, f.clock);
  const review = await run(f);
  assert.equal((await run(f, review.preview.digest)).status, "WAIT_INTERVAL");
  f.advance(61_000);
  assert.equal((await run(f, review.preview.digest)).status, "PUBLISHED");
  assert.equal(f.sends().length, 2);
});
test("stock changed during claim blocks reopening, including concurrent double click", async () => {
  const f = stopped(), review = await run(f); f.state.changeStockAfterClaim = true;
  assert.equal((await run(f, review.preview.digest)).status, "RESULT_UNKNOWN_NO_RESEND");
  assert.equal(f.sends().length, 0);
  const g = stopped(), r = await run(g);
  await Promise.all([run(g, r.preview.digest), run(g, r.preview.digest)]);
  assert.equal(g.sends().length, 1);
});
test("lost reopen response is verified once without recreation", async () => {
  const f = stopped(), r = await run(f); f.state.timeoutAfterCommit = true;
  assert.equal((await run(f, r.preview.digest)).status, "PUBLISHED"); assert.equal(f.sends().length, 1);
});
test("state refresh clears a stop or reopen guard after temporarily failed readback", async () => {
  for (const reopening of [false, true]) {
    const f = reopening ? stopped() : fixture();
    const review = reopening ? await run(f) : null;
    f.state.readFailsAfterSend = true;
    const first = reopening ? await run(f, review.preview.digest) :
      await stopObservedWebHttpProductOnce(inventoryId, admin, f.ports, f.clock);
    assert.equal(first.status, "RESULT_UNKNOWN_NO_RESEND");
    assert.ok(await f.repo.getPendingProductStop());
    f.state.readFailsAfterSend = false;
    assert.equal(await refresh(f), "CLEAR"); assert.equal(await f.repo.getPendingProductStop(), null);
    assert.equal(f.sends().length, 1);
  }
});
test("unresolved opposite operation blocks writes and refresh cannot invent success", async () => {
  const f = fixture(); f.state.timeoutBeforeCommit = true;
  await stopObservedWebHttpProductOnce(inventoryId, admin, f.ports, f.clock);
  assert.equal((await run(f)).status, "RESULT_UNKNOWN_NO_RESEND");
  assert.equal(await refresh(f), "PENDING"); assert.equal(f.sends().length, 1);
});

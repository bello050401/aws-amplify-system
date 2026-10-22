import test from "node:test";
import assert from "node:assert/strict";
import {
  fixture,
  inventoryId,
  admin,
} from "./webHttpProductLifecycle.fixture.mjs";
import { updateObservedWebHttpContent } from "./webHttpContentUpdate.ts";

function setup() {
  const f = fixture(),
    attempts = new Map();
  let slot = null,
    pending = null,
    uploads = 0,
    saved = 0;
  const source = {
    fingerprint: "a".repeat(64),
    title: "Updated chair",
    description: "New description",
    price: 12300,
    quantity: 3,
    images: [{ storageKey: "inventory/new.jpg", sortOrder: 0 }],
  };
  const repo = {
    getSlot: async () => structuredClone(slot),
    getAttempt: async (id) => structuredClone(attempts.get(id) ?? null),
    getPendingProductStop: async () => pending,
    transactReserve: async (previous, next, a, time) => {
      if (
        attempts.has(a.requestId) ||
        (pending && a.remoteProductId) ||
        (slot &&
          (slot.revision !== previous?.revision || slot.nextEligibleAt > time))
      )
        throw Error("conflict");
      slot = structuredClone(next);
      attempts.set(a.requestId, structuredClone(a));
      if (a.remoteProductId) pending = a.requestId;
    },
    claimMutationStart: async (id, attemptId) => {
      const a = attempts.get(id);
      if (a?.status !== "RESERVED_NO_SEND" || a.attemptId !== attemptId)
        throw Error("conflict");
      a.status = "SEND_CLAIMED_RESULT_UNKNOWN";
      if (f.state.changeSourceAfterClaim) source.fingerprint = "b".repeat(64);
    },
    acknowledgeImageAsset: async (id, attemptId, asset, sha) => {
      const a = attempts.get(id);
      assert.equal(a.attemptId, attemptId);
      assert.equal(a.status, "SEND_CLAIMED_RESULT_UNKNOWN");
      Object.assign(a, {
        status: "IMAGE_ACKNOWLEDGED",
        remoteAssetId: asset,
        preparedJpegSha256: sha,
      });
    },
    verifyProductStop: async (
      id,
      attemptId,
      shop,
      product,
      fp,
      time,
      status,
    ) => {
      const a = attempts.get(id);
      assert.equal(a.attemptId, attemptId);
      assert.equal(a.productContentFingerprint, fp);
      assert.equal(a.status, "SEND_CLAIMED_RESULT_UNKNOWN");
      a.status =
        status === "STATUS_OPENED"
          ? "PRODUCT_REOPEN_VERIFIED"
          : "PRODUCT_STOP_VERIFIED";
      pending = null;
    },
    cancelUnclaimedProductStop: async () => {
      throw Error("not expected");
    },
  };
  const original = f.ports.fetchPort;
  f.ports = {
    ...f.ports,
    repository: repo,
    readSource: async () => structuredClone(source),
    saveVerifiedState: async () => {
      saved++;
    },
    imageJpeg: async () => new Uint8Array([255, 216, 255, 217]),
    fetchPort: async (url, init) => {
      if (init.body instanceof FormData) {
        uploads++;
        if (f.state.failImage) throw Error("lost image response");
        return new Response(
          JSON.stringify({
            data: {
              createImageAsset: {
                id: "Image" + uploads,
                contentType: "image/jpeg",
              },
            },
          }),
        );
      }
      const body = JSON.parse(init.body);
      if (
        body.operationName === "UpdateProductV2" &&
        !f.state.timeoutBeforeCommit
      ) {
        const input = body.variables.input,
          p = f.product();
        Object.assign(p, {
          name: input.name,
          description: input.description,
          price: input.price,
          thumbnails: input.assetIds.map((id) => ({ id })),
        });
        p.variants[0].quantity = input.variants[0].quantity;
        p.categories = input.categoryIds.map(id=>({category:[{id}]}));
        p.shippingMethodType = {id:input.shippingMethodType};
      }
      return original(url, init);
    },
  };
  return { ...f, source, attempts, uploads: () => uploads, saved: () => saved };
}
const run = (f, token = null) =>
  updateObservedWebHttpContent(inventoryId, admin, token, f.ports, f.clock);
async function prepare(f) {
  const r = await run(f);
  assert.equal(r.status, "READY");
  assert.equal((await run(f, r.token)).status, "WAIT");
  f.advance(61000);
  return r.token;
}

test("review writes nothing; update changes unit price, count and photos while preserving visibility/shipping", async () => {
  const f = setup(),
    r = await run(f);
  assert.equal(r.price, 12300);
  assert.equal(r.quantity, 3);
  assert.equal(f.uploads(), 0);
  assert.equal(f.sends().length, 0);
  assert.equal((await run(f, "b".repeat(64))).status, "BLOCKED");
  assert.equal(f.uploads(), 0);
  const token = await prepare(f);
  assert.equal((await run(f, token)).status, "DONE");
  assert.equal(f.product().price, 12300);
  assert.equal(f.product().variants[0].quantity, 3);
  assert.equal(f.product().thumbnails.length, 1);
  assert.equal(f.product().status.id, "STATUS_OPENED");
  assert.equal(
    f.sends()[0].variables.input.shippingMethodType,
    "METHOD_MERCARI_SHIPPING_YAMATO",
  );
  assert.equal((await run(f)).status, "DONE");
  assert.equal(f.sends().length, 1);
  assert.equal(f.uploads(), 1);
});
test("update preserves stopped products and verifies lost successful responses", async () => {
  const f = setup();
  f.product().status.id = "STATUS_UNOPENED";
  const token = await prepare(f);
  f.state.timeoutAfterCommit = true;
  assert.equal((await run(f, token)).status, "DONE");
  assert.equal(f.product().status.id, "STATUS_UNOPENED");
  assert.equal(f.sends().length, 1);
});
test("uncertain image and product writes never resend", async () => {
  const f = setup(),
    r = await run(f);
  f.state.failImage = true;
  assert.equal((await run(f, r.token)).status, "BLOCKED");
  f.advance(61000);
  assert.equal((await run(f, r.token)).status, "BLOCKED");
  assert.equal(f.uploads(), 1);
  assert.equal(f.sends().length, 0);
  const g = setup(),
    token = await prepare(g);
  g.state.timeoutBeforeCommit = true;
  assert.equal((await run(g, token)).status, "BLOCKED");
  g.advance(61000);
  assert.equal((await run(g, token)).status, "BLOCKED");
  assert.equal(g.sends().length, 1);
});
test("source and remote changes after confirmation block sending", async () => {
  for (const change of [
    (f) => {
      f.source.fingerprint = "c".repeat(64);
    },
    (f) => {
      f.product().price = 4000;
    },
  ]) {
    const f = setup(),
      token = await prepare(f);
    change(f);
    assert.equal((await run(f, token)).status, "BLOCKED");
    assert.equal(f.sends().length, 0);
  }
  const f = setup(),
    token = await prepare(f);
  f.state.changeSourceAfterClaim = true;
  assert.equal((await run(f, token)).status, "BLOCKED");
  assert.equal(f.sends().length, 0);
});
test("simultaneous confirmations produce at most one write", async () => {
  const f = setup(),
    token = await prepare(f);
  await Promise.all([run(f, token), run(f, token)]);
  assert.equal(f.sends().length, 1);
});

test('common category and regular shipping apply without visiting the channel tab',async()=>{
 const f=setup();f.source.categoryId='dining_chairs';f.source.shippingMethodType='METHOD_TYPE_UNDECIDED';
 const token=await prepare(f);assert.equal((await run(f,token)).status,'DONE');
 assert.deepEqual(f.sends()[0].variables.input.categoryIds,['dining_chairs']);
 assert.equal(f.sends()[0].variables.input.shippingMethodType,'METHOD_TYPE_UNDECIDED');
 assert.equal((await run(f)).status,'DONE');assert.equal(f.sends().length,1);
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capturePublicVisibilityProofReadOnly,
  readCurrentPublicVisibilityProof } from
  "../src/visibilityPublicProof.mjs";

const target = { shopId: "evkhihBFFNn5hukMS9s36H",
  inventoryId: "bd4850de-9156-4890-a821-cae75da5c8f7",
  remoteId: "ownedProduct123", title: "Exact owned product",
  skuCode: "B009999", priceYen: 45000, quantity: 1,
  visibilityPolicy: "PUBLIC_ALLOWED" };
async function withRoot(action) {
  const root = await mkdtemp(join(tmpdir(), "bello-public-proof-"));
  try { return await action(root); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test("only an exact public seller-list read becomes a fresh stored proof", async () => {
  await withRoot(async root => {
    let closed = false;
    const result = await capturePublicVisibilityProofReadOnly({ root,
      profileDir: join(root, "ShopsChrome"),
      playwrightModulePath: join(root, "playwright", "package.json"),
      target }, {
      openSession: async () => ({ page: {}, context: {
        close: async () => { closed = true; } } }),
      readVisibility: async (_, expected) => ({ kind: "OBSERVED",
        shopId: expected.shopId, remoteId: expected.remoteId,
        title: expected.title, visibility: "PUBLIC" }),
    });
    assert.equal(result.status, "PUBLIC_CONFIRMED");
    assert.equal(result.allowStop, true);
    assert.equal(closed, true);
    assert.equal((await readCurrentPublicVisibilityProof(root, target)).allowStop,
      true);
    assert.equal((await readCurrentPublicVisibilityProof(root, {
      ...target, remoteId: "anotherProduct" })).allowStop, false);
    assert.equal((await readCurrentPublicVisibilityProof(root, target,
      Date.parse(result.observedAt) + 120_001)).diagnostic, "PROOF_EXPIRED");
  });
});

test("auth loss, private row and unknown observation never authorize STOP", async () => {
  await withRoot(async root => {
    let closed = 0;
    for (const observed of [
      { kind: "UNOBSERVED", code: "LIST_URL_CHANGED" },
      { kind: "OBSERVED", shopId: target.shopId,
        remoteId: target.remoteId, title: target.title,
        visibility: "PRIVATE" },
    ]) {
      const result = await capturePublicVisibilityProofReadOnly({ root,
        profileDir: join(root, "ShopsChrome"),
        playwrightModulePath: join(root, "playwright", "package.json"),
        target }, { openSession: async () => ({ page: {}, context: {
          close: async () => { closed++; } } }),
          readVisibility: async () => observed });
      assert.equal(result.allowStop, false);
    }
    assert.equal(closed, 2);
    assert.equal((await readCurrentPublicVisibilityProof(root, target)).allowStop,
      false);
  });
});

import assert from "node:assert/strict";
import test from "node:test";
import { exactVisibilitySearchUrl, readExactVisibilityFromList } from
  "../src/visibilityReadback.mjs";

const shopId = "evkhihBFFNn5hukMS9s36H";
const title = "BoConcept Lugano TV Board";

test("normal list search keeps the observed filter and exact shop", () => {
  assert.equal(exactVisibilitySearchUrl(shopId, title, "PUBLIC"),
    `https://mercari-shops.com/seller/shops/${shopId}/products?tab=on_sale&visibility=opened&keyword=BoConcept+Lugano+TV+Board`);
  assert.equal(exactVisibilitySearchUrl(shopId, title, "PRIVATE"),
    `https://mercari-shops.com/seller/shops/${shopId}/products?tab=on_sale&visibility=unopened&keyword=BoConcept+Lugano+TV+Board`);
  assert.equal(exactVisibilitySearchUrl("otherShop", title, "PUBLIC"), null);
  assert.equal(exactVisibilitySearchUrl(shopId, "bad\nname", "PUBLIC"), null);
  assert.equal(exactVisibilitySearchUrl(shopId, title, "STOPPED"), null);
});

test("wrong identity is rejected without opening a Shops page", async () => {
  const page = { goto: async () => { throw Error("must not navigate"); } };
  assert.deepEqual(await readExactVisibilityFromList(page, {
    shopId, remoteId: "../old", title, visibility: "PUBLIC" }),
  { kind: "UNOBSERVED", code: "INVALID_TARGET" });
});

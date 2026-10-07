import test from "node:test";
import assert from "node:assert/strict";
import { exactPrivateCreateFinalView, withVerifiedPrivateCreateSend } from
  "../src/privateCreateFinalCheck.mjs";

const target = { shopId: "evkhihBFFNn5hukMS9s36H",
  inventoryId: "5b0f3587-cbbb-4c09-ae78-595b2b3e353f",
  operation: "CREATE", attemptId: "11111111-1111-4111-8111-111111111111" };
const createUrl = `https://mercari-shops.com/seller/shops/${target.shopId}/products/create`;
const snapshot = { title: "Test chair", description: "Known description",
  testPriceYen: 99999, quantity: 1, testManagementCode: "TEST_B005413" };
const category = ["家具・インテリア", "椅子・チェア", "椅子"];
const shipping = { "shippingMethodType.id": "METHOD_TYPE_UNDECIDED",
  "shippingPayerType.id": "PAYER_TYPE_SELLER",
  "shippingFromState.id": "jp11",
  "shippingDurationType.id": "DURATION_TYPE_FOUR_TO_SEVEN_DAYS" };
const view = () => ({ fields: { name: snapshot.title,
  description: snapshot.description, price: "¥99,999",
  "variants.0.quantity": "1", "variants.0.skuCode": snapshot.testManagementCode,
  ...shipping }, condition: "目立った傷や汚れなし",
  categoryLeaf: "椅子",
  categoryGroup: "カテゴリー 家具・インテリア > 椅子・チェア > 椅子" });

test("final view requires exact condition, leaf, category path and price", () => {
  assert.equal(exactPrivateCreateFinalView(snapshot, view(), category, shipping), true);
  assert.equal(exactPrivateCreateFinalView(snapshot, { ...view(),
    fields: { ...view().fields, price: "¥100,000" } }, category, shipping), false);
  assert.equal(exactPrivateCreateFinalView(snapshot, { ...view(),
    categoryLeaf: "座椅子" }, category, shipping), false);
  assert.equal(exactPrivateCreateFinalView(snapshot, { ...view(),
    condition: "やや目立った傷や汚れなし" }, category, shipping), false);
});

test("price or page changes during the gate wait prevent the final click", async () => {
  for (const mutate of [state => { state.form.fields.price = "¥100,000"; },
    state => { state.url = `https://mercari-shops.com/seller/shops/${target.shopId}/products/other/edit`; }]) {
    const state = { url: createUrl, form: view() };
    let clicked = 0;
    let waited = false;
    await assert.rejects(withVerifiedPrivateCreateSend("queue", target,
      async () => state.url === createUrl &&
        exactPrivateCreateFinalView(snapshot, state.form, category, shipping),
      async () => { clicked += 1; }, {
        gate: async (_root, operation, action) => {
          assert.equal(operation.operation, "CREATE");
          mutate(state); waited = true;
          return action();
        },
      }), /PRIVATE_CREATE_FINAL_FORM_CHANGED/);
    assert.equal(waited, true);
    assert.equal(clicked, 0);
  }
});

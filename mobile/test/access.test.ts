import test from "node:test";
import assert from "node:assert/strict";
import { canOpenTab, isMobileFeatures, permittedTab, RESTRICTED_FEATURES } from "../src/domain/access";

test("staff can use home and inventory but cannot open EC or sales", () => {
  assert.equal(canOpenTab("home", RESTRICTED_FEATURES), true);
  assert.equal(canOpenTab("inventory", RESTRICTED_FEATURES), true);
  assert.equal(canOpenTab("ec", RESTRICTED_FEATURES), false);
  assert.equal(canOpenTab("sales", RESTRICTED_FEATURES), false);
});
test("independent feature permissions and revocation of an already open screen", () => {
  assert.equal(permittedTab("sales", { ecListing: true, sales: false }), "home");
  assert.equal(permittedTab("ec", { ecListing: true, sales: false }), "ec");
  assert.equal(permittedTab("ec", { ecListing: false, sales: true }), "home");
  assert.equal(permittedTab("sales", { ecListing: false, sales: true }), "sales");
});
test("absent, malformed, and truthy nonboolean feature data are rejected", () => {
  for (const input of [null, undefined, {}, { ecListing: true }, { ecListing: "true", sales: true }]) assert.equal(isMobileFeatures(input), false);
  assert.equal(isMobileFeatures({ ecListing: false, sales: false }), true);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { initialYahooAmounts, editYahooAmounts, yahooAmountError, yahooPurchaseUnitPrice } from "../lib/procurement/yahooAmounts";

test("unknown shipping starts at zero; four chairs show the unit price, not the lot total", () => {
  const row = initialYahooAmounts({ quantity: 4, itemTotal: 35200, shipping: null });
  assert.deepEqual(row, { count: "4", total: "35200", postage: "0", unitPrice: "8800" });
  assert.equal(yahooAmountError(row), null);
});
test("known shipping is preserved and included only once", () => {
  const row = initialYahooAmounts({ quantity: 4, itemTotal: 35200, shipping: 1200 });
  assert.equal(row.unitPrice, "9100");
  assert.equal(row.postage, "1200");
  const edit = editYahooAmounts(row, "postage", "400");
  assert.equal(edit.unitPrice, "8900");
  assert.equal(edit.total, "35200");
});
test("rounded unit display does not change the exact ledger total", () => {
  const row = initialYahooAmounts({ quantity: 3, itemTotal: 800, shipping: 0 });
  assert.equal(row.unitPrice, "267");
  assert.equal(editYahooAmounts(row, "unitPrice", "267").total, "800");
  assert.equal(editYahooAmounts(row, "count", "4").unitPrice, "200");
  assert.equal(editYahooAmounts(row, "postage", "100").unitPrice, "300");
});
test("explicit unit edit calculates the matching total without adding shipping twice", () => {
  const row = initialYahooAmounts({ quantity: 4, itemTotal: 35200, shipping: 400 });
  const edit = editYahooAmounts(row, "unitPrice", "9000");
  assert.equal(edit.total, "35600");
  assert.equal(Number(edit.total) + Number(edit.postage), 36000);
  assert.equal(yahooPurchaseUnitPrice(Number(edit.total), Number(edit.postage), Number(edit.count)), 9000);
  assert.equal(yahooAmountError(edit), null);
});
test("empty fields, fractional quantities, negatives and overflow cannot be registered", () => {
  const row = initialYahooAmounts({ quantity: 4, itemTotal: 35200, shipping: 400 });
  for (const [field, value] of [["count", ""], ["count", "0"], ["count", "1.5"], ["count", "10001"], ["postage", ""], ["postage", "-1"], ["unitPrice", ""], ["unitPrice", "-1"], ["unitPrice", "1"], ["unitPrice", "2147483647"]] as const) {
    assert.ok(yahooAmountError(editYahooAmounts(row, field, value)), field + " " + value);
  }
});

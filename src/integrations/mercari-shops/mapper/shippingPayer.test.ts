import { describe, expect, it } from "vitest";
import { SHIPPING_PAYERS, shippingPayerLabel, shippingPayerToMercariValue } from "./shippingPayer";

describe("shippingPayer mapper", () => {
  it("covers SELLER and BUYER (指示書23項)", () => {
    expect(SHIPPING_PAYERS.map((p) => p.code)).toEqual(["SELLER", "BUYER"]);
  });

  it("labels SELLER as 送料込み（出品者負担）", () => {
    expect(shippingPayerLabel("SELLER")).toBe("送料込み（出品者負担）");
  });

  it("labels BUYER as 着払い（購入者負担）", () => {
    expect(shippingPayerLabel("BUYER")).toBe("着払い（購入者負担）");
  });

  it("maps to a Mercari API value", () => {
    expect(shippingPayerToMercariValue("BUYER")).toBe("BUYER");
  });
});

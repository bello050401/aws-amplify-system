import { describe, expect, it } from "vitest";
import { productFormSchema } from "./productSchema";
import { MERCARI_LIMITS } from "@/integrations/mercari-shops/types/limits";

const base = {
  sku: "BELLO-000001",
  name: "柏木工 KASHIWA ウィンザーチェア",
  description: "テスト説明文",
  price: 29800,
  condition: "NO_NOTABLE_DAMAGE" as const,
  categoryMappingId: "cat-1",
  brandMappingId: null,
  janCode: null,
  catalogId: null,
  shippingPayer: "SELLER" as const,
  shippingFromStateId: "13",
  shippingDurationCode: "FOUR_SEVEN_DAYS",
  shippingTemplateId: null,
  stockQuantity: 1,
};

describe("productFormSchema (指示書8, 9, 18項)", () => {
  it("accepts a valid product", () => {
    expect(productFormSchema.safeParse(base).success).toBe(true);
  });

  it("rejects a SKU with disallowed characters", () => {
    const result = productFormSchema.safeParse({ ...base, sku: "BELLO 000001" });
    expect(result.success).toBe(false);
  });

  it(`rejects a product name longer than ${MERCARI_LIMITS.NAME_MAX} characters`, () => {
    const tooLong = "あ".repeat(MERCARI_LIMITS.NAME_MAX + 1);
    const result = productFormSchema.safeParse({ ...base, name: tooLong });
    expect(result.success).toBe(false);
  });

  it(`accepts a description up to ${MERCARI_LIMITS.DESCRIPTION_MAX} characters`, () => {
    const maxLength = "あ".repeat(MERCARI_LIMITS.DESCRIPTION_MAX);
    const result = productFormSchema.safeParse({ ...base, description: maxLength });
    expect(result.success).toBe(true);
  });

  it(`rejects a description longer than ${MERCARI_LIMITS.DESCRIPTION_MAX} characters`, () => {
    const tooLong = "あ".repeat(MERCARI_LIMITS.DESCRIPTION_MAX + 1);
    const result = productFormSchema.safeParse({ ...base, description: tooLong });
    expect(result.success).toBe(false);
  });

  it("rejects a price of 0 (must be at least 1 yen)", () => {
    const result = productFormSchema.safeParse({ ...base, price: 0 });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown condition code", () => {
    const result = productFormSchema.safeParse({ ...base, condition: "MINT" });
    expect(result.success).toBe(false);
  });

  it("allows categoryMappingId to be null (未設定, checked later by ListingService)", () => {
    const result = productFormSchema.safeParse({ ...base, categoryMappingId: null });
    expect(result.success).toBe(true);
  });
});

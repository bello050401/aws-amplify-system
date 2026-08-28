import { describe, expect, it } from "vitest";
import { DEFAULT_ITEM_FORM_VALUES, itemFormSchema } from "./itemSchema";

describe("itemFormSchema", () => {
  it("accepts default values plus a name", () => {
    const result = itemFormSchema.safeParse({ ...DEFAULT_ITEM_FORM_VALUES, name: "テスト椅子" });
    expect(result.success).toBe(true);
  });

  it("rejects empty name", () => {
    const result = itemFormSchema.safeParse({ ...DEFAULT_ITEM_FORM_VALUES, name: "" });
    expect(result.success).toBe(false);
  });

  it("rejects negative quantity", () => {
    const result = itemFormSchema.safeParse({ ...DEFAULT_ITEM_FORM_VALUES, name: "椅子", quantity: -1 });
    expect(result.success).toBe(false);
  });

  it("rejects malformed date", () => {
    const result = itemFormSchema.safeParse({
      ...DEFAULT_ITEM_FORM_VALUES,
      name: "椅子",
      transactionDate: "2026/08/28",
    });
    expect(result.success).toBe(false);
  });

  it("rejects condition rating outside 1-5", () => {
    const result = itemFormSchema.safeParse({ ...DEFAULT_ITEM_FORM_VALUES, name: "椅子", condition: 6 });
    expect(result.success).toBe(false);
  });
});

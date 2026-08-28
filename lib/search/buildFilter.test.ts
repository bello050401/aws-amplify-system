import { describe, expect, it } from "vitest";
import { isSearchQueryReady, matchesAdvancedQuery, matchesCondition, matchesKeyword } from "./buildFilter";
import type { Item, SearchCondition } from "@/lib/types";

function makeItem(overrides: Partial<Item> = {}): Item {
  return {
    id: "item_1",
    name: "3人掛けソファ",
    barcode: "4900000000001",
    quantity: 5,
    freeQuantity: 5,
    reorderPoint: 1,
    unit: "点",
    status: "販売中",
    notes: "傷は写真参照",
    categoryId: "cat_sofa",
    locationId: "loc_a1",
    thumbnailKey: null,
    imageKeys: [],
    plannedPrice: 10000,
    discountPrice30: 9000,
    discountPrice60: 8000,
    discountPrice90: 7000,
    condition: 4,
    damageNotes: null,
    widthCm: 180,
    depthCm: 80,
    heightCm: 90,
    lengthCm: 180,
    householdCategory: "家具",
    itemType: "ソファ",
    transactionDate: "2026-06-01",
    antiqueFeature: "使用感あり",
    stocktakeDate: "2026-08-01",
    isDeleted: false,
    version: 1,
    userGroup: "Staff",
    updatedBy: "tester",
    createdBy: "tester",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("matchesCondition", () => {
  it("string contains", () => {
    const item = makeItem();
    const c: SearchCondition = { id: "1", field: "name", label: "物品名", type: "string", operator: "contains", value: "ソファ" };
    expect(matchesCondition(item, c)).toBe(true);
    expect(matchesCondition(item, { ...c, value: "テーブル" })).toBe(false);
  });

  it("string notContains", () => {
    const item = makeItem();
    const c: SearchCondition = { id: "1", field: "name", label: "物品名", type: "string", operator: "notContains", value: "テーブル" };
    expect(matchesCondition(item, c)).toBe(true);
  });

  it("number range (planned price)", () => {
    const item = makeItem({ plannedPrice: 9500 });
    const c: SearchCondition = {
      id: "1",
      field: "plannedPrice",
      label: "価格",
      type: "number",
      operator: "range",
      value: 9000,
      valueTo: 10000,
    };
    expect(matchesCondition(item, c)).toBe(true);
    expect(matchesCondition({ ...item, plannedPrice: 500 }, c)).toBe(false);
  });

  it("number gte/lte", () => {
    const item = makeItem({ quantity: 5 });
    expect(
      matchesCondition(item, { id: "1", field: "quantity", label: "数量", type: "number", operator: "gte", value: 5 })
    ).toBe(true);
    expect(
      matchesCondition(item, { id: "1", field: "quantity", label: "数量", type: "number", operator: "lte", value: 4 })
    ).toBe(false);
  });

  it("condition rating 1-5", () => {
    const item = makeItem({ condition: 3 });
    expect(
      matchesCondition(item, { id: "1", field: "condition", label: "コンディション", type: "condition", operator: "eq", value: 3 })
    ).toBe(true);
  });

  it("date before/after/range", () => {
    const item = makeItem({ stocktakeDate: "2026-08-15" });
    expect(
      matchesCondition(item, { id: "1", field: "stocktakeDate", label: "棚卸日", type: "date", operator: "after", value: "2026-08-01" })
    ).toBe(true);
    expect(
      matchesCondition(item, { id: "1", field: "stocktakeDate", label: "棚卸日", type: "date", operator: "before", value: "2026-08-01" })
    ).toBe(false);
    expect(
      matchesCondition(item, {
        id: "1",
        field: "stocktakeDate",
        label: "棚卸日",
        type: "date",
        operator: "range",
        value: "2026-08-01",
        valueTo: "2026-08-31",
      })
    ).toBe(true);
  });

  it("category / location eq", () => {
    const item = makeItem({ categoryId: "cat_sofa" });
    expect(
      matchesCondition(item, { id: "1", field: "categoryId", label: "カテゴリ", type: "category", operator: "eq", value: "cat_sofa" })
    ).toBe(true);
    expect(
      matchesCondition(item, { id: "1", field: "categoryId", label: "カテゴリ", type: "category", operator: "eq", value: "cat_table" })
    ).toBe(false);
  });
});

describe("matchesAdvancedQuery", () => {
  const item = makeItem({ quantity: 5, condition: 4 });
  const condA: SearchCondition = { id: "a", field: "quantity", label: "数量", type: "number", operator: "gte", value: 3 };
  const condB: SearchCondition = { id: "b", field: "condition", label: "コンディション", type: "condition", operator: "eq", value: 1 };

  it("AND requires all conditions", () => {
    expect(matchesAdvancedQuery(item, { combinator: "AND", conditions: [condA, condB] })).toBe(false);
    expect(matchesAdvancedQuery(item, { combinator: "AND", conditions: [condA] })).toBe(true);
  });

  it("OR requires any condition", () => {
    expect(matchesAdvancedQuery(item, { combinator: "OR", conditions: [condA, condB] })).toBe(true);
  });

  it("empty conditions matches everything", () => {
    expect(matchesAdvancedQuery(item, { combinator: "AND", conditions: [] })).toBe(true);
  });
});

describe("matchesKeyword", () => {
  it("matches across multiple fields case-insensitively", () => {
    const item = makeItem({ name: "Sofa", notes: "レア商品" });
    expect(matchesKeyword(item, "sofa")).toBe(true);
    expect(matchesKeyword(item, "レア")).toBe(true);
    expect(matchesKeyword(item, "存在しない")).toBe(false);
  });

  it("empty keyword matches everything", () => {
    expect(matchesKeyword(makeItem(), "")).toBe(true);
  });
});

describe("isSearchQueryReady", () => {
  it("requires value for non-range operators", () => {
    const q = { combinator: "AND" as const, conditions: [{ id: "1", field: "name" as const, label: "物品名", type: "string" as const, operator: "contains" as const, value: "" }] };
    expect(isSearchQueryReady(q)).toBe(false);
  });

  it("requires both bounds for range", () => {
    const q = {
      combinator: "AND" as const,
      conditions: [{ id: "1", field: "quantity" as const, label: "数量", type: "number" as const, operator: "range" as const, value: 1, valueTo: null }],
    };
    expect(isSearchQueryReady(q)).toBe(false);
  });

  it("category/location without value is still ready (no filter)", () => {
    const q = {
      combinator: "AND" as const,
      conditions: [{ id: "1", field: "categoryId" as const, label: "カテゴリ", type: "category" as const, operator: "eq" as const, value: null }],
    };
    expect(isSearchQueryReady(q)).toBe(true);
  });
});

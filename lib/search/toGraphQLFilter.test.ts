import { describe, expect, it } from "vitest";
import { advancedQueryToGraphQLFilter, combineFilters, keywordToGraphQLFilter } from "./toGraphQLFilter";
import type { AdvancedSearchQuery } from "@/lib/types";

describe("advancedQueryToGraphQLFilter", () => {
  it("returns undefined for empty conditions", () => {
    expect(advancedQueryToGraphQLFilter({ combinator: "AND", conditions: [] })).toBeUndefined();
  });

  it("wraps multiple conditions with and/or", () => {
    const query: AdvancedSearchQuery = {
      combinator: "OR",
      conditions: [
        { id: "1", field: "name", label: "物品名", type: "string", operator: "contains", value: "ソファ" },
        { id: "2", field: "quantity", label: "数量", type: "number", operator: "gte", value: 3 },
      ],
    };
    const filter = advancedQueryToGraphQLFilter(query);
    expect(filter).toEqual({
      or: [{ name: { contains: "ソファ" } }, { quantity: { ge: 3 } }],
    });
  });

  it("range produces a between clause", () => {
    const query: AdvancedSearchQuery = {
      combinator: "AND",
      conditions: [{ id: "1", field: "plannedPrice", label: "価格", type: "number", operator: "range", value: 1000, valueTo: 2000 }],
    };
    expect(advancedQueryToGraphQLFilter(query)).toEqual({ plannedPrice: { between: [1000, 2000] } });
  });
});

describe("keywordToGraphQLFilter", () => {
  it("builds an OR contains filter across searchable fields", () => {
    const filter = keywordToGraphQLFilter("ソファ");
    expect(filter?.or).toBeDefined();
    expect(filter!.or.length).toBeGreaterThan(0);
  });

  it("returns undefined for blank keyword", () => {
    expect(keywordToGraphQLFilter("   ")).toBeUndefined();
  });
});

describe("combineFilters", () => {
  it("drops undefined filters and wraps remaining with and", () => {
    const combined = combineFilters(undefined, { a: 1 }, undefined, { b: 2 });
    expect(combined).toEqual({ and: [{ a: 1 }, { b: 2 }] });
  });

  it("returns the single filter unwrapped", () => {
    expect(combineFilters({ a: 1 })).toEqual({ a: 1 });
  });

  it("returns undefined when nothing provided", () => {
    expect(combineFilters(undefined, undefined)).toBeUndefined();
  });
});

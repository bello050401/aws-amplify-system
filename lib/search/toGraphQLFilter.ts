import type { AdvancedSearchQuery, SearchCondition } from "@/lib/types";

/**
 * AdvancedSearchQuery / キーワード検索を AWS AppSync (Amplify Data) の
 * filter入力に変換する。PC版・モバイル版の詳細検索は同じ
 * AdvancedSearchQuery構造・同じこの変換関数・同じAPIを利用する(指示書 §13-3)。
 *
 * 演算子の対応は lib/search/buildFilter.ts (ローカルモック用の同等ロジック)
 * と意味的に一致させている。
 */
type GraphQLFilter = Record<string, any>;

function conditionToFilter(c: SearchCondition): GraphQLFilter | null {
  if (c.type === "string") {
    const value = c.value == null ? "" : String(c.value);
    if (value === "") return null;
    if (c.operator === "contains") return { [c.field]: { contains: value } };
    if (c.operator === "exact") return { [c.field]: { eq: value } };
    if (c.operator === "notContains") return { [c.field]: { notContains: value } };
    return null;
  }

  if (c.type === "number" || c.type === "condition") {
    if (c.value === null || c.value === undefined || c.value === "") return null;
    const value = Number(c.value);
    switch (c.operator) {
      case "eq":
        return { [c.field]: { eq: value } };
      case "gt":
        return { [c.field]: { gt: value } };
      case "gte":
        return { [c.field]: { ge: value } };
      case "lt":
        return { [c.field]: { lt: value } };
      case "lte":
        return { [c.field]: { le: value } };
      case "range": {
        const to = Number(c.valueTo);
        const lo = Math.min(value, to);
        const hi = Math.max(value, to);
        return { [c.field]: { between: [lo, hi] } };
      }
      default:
        return null;
    }
  }

  if (c.type === "date") {
    if (!c.value) return null;
    const value = String(c.value);
    switch (c.operator) {
      case "before":
        return { [c.field]: { lt: value } };
      case "after":
        return { [c.field]: { gt: value } };
      case "range": {
        const to = c.valueTo ? String(c.valueTo) : value;
        return { [c.field]: { between: [value, to] } };
      }
      default:
        return null;
    }
  }

  if (c.type === "category" || c.type === "location") {
    if (!c.value) return null;
    return { [c.field]: { eq: String(c.value) } };
  }

  return null;
}

export function advancedQueryToGraphQLFilter(query: AdvancedSearchQuery): GraphQLFilter | undefined {
  const clauses = query.conditions.map(conditionToFilter).filter((c): c is GraphQLFilter => c !== null);
  if (clauses.length === 0) return undefined;
  if (clauses.length === 1) return clauses[0];
  return query.combinator === "AND" ? { and: clauses } : { or: clauses };
}

const KEYWORD_SEARCHABLE_FIELDS = ["name", "barcode", "notes", "status", "itemType"];

export function keywordToGraphQLFilter(keyword: string): GraphQLFilter | undefined {
  const k = keyword.trim();
  if (!k) return undefined;
  return { or: KEYWORD_SEARCHABLE_FIELDS.map((f) => ({ [f]: { contains: k } })) };
}

export function combineFilters(...filters: (GraphQLFilter | undefined)[]): GraphQLFilter | undefined {
  const present = filters.filter((f): f is GraphQLFilter => !!f);
  if (present.length === 0) return undefined;
  if (present.length === 1) return present[0];
  return { and: present };
}

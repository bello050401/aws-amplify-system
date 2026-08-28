import type { AdvancedSearchQuery, Item, SearchCondition } from "@/lib/types";

/**
 * 詳細検索の条件をアイテムに対して評価する純粋関数。
 *
 * PC版・モバイル版・単体テストで共通利用する「唯一の検索ロジック」。
 * (Amplify Data(AppSync)へ問い合わせる際は、この同じ条件オブジェクトを
 *  GraphQLのfilter式に変換して使う。 lib/api/amplifyRepository.ts 参照)
 */
export function matchesCondition(item: Item, condition: SearchCondition): boolean {
  const raw = (item as unknown as Record<string, unknown>)[condition.field];

  if (condition.type === "string") {
    const target = String(raw ?? "").toLowerCase();
    const value = String(condition.value ?? "").toLowerCase();
    if (value === "") return true;
    switch (condition.operator) {
      case "contains":
        return target.includes(value);
      case "exact":
        return target === value;
      case "notContains":
        return !target.includes(value);
      default:
        return true;
    }
  }

  if (condition.type === "number" || condition.type === "condition") {
    const target = typeof raw === "number" ? raw : Number(raw);
    if (Number.isNaN(target)) return false;
    const value = Number(condition.value);
    switch (condition.operator) {
      case "eq":
        return target === value;
      case "gt":
        return target > value;
      case "gte":
        return target >= value;
      case "lt":
        return target < value;
      case "lte":
        return target <= value;
      case "range": {
        const to = Number(condition.valueTo);
        const lo = Math.min(value, to);
        const hi = Math.max(value, to);
        return target >= lo && target <= hi;
      }
      default:
        return true;
    }
  }

  if (condition.type === "date") {
    if (!raw) return false;
    const target = String(raw);
    const value = String(condition.value ?? "");
    switch (condition.operator) {
      case "before":
        return value !== "" && target < value;
      case "after":
        return value !== "" && target > value;
      case "range": {
        const to = String(condition.valueTo ?? "");
        if (value === "" || to === "") return true;
        return target >= value && target <= to;
      }
      default:
        return true;
    }
  }

  if (condition.type === "category" || condition.type === "location") {
    if (!condition.value) return true;
    return String(raw ?? "") === String(condition.value);
  }

  return true;
}

export function matchesAdvancedQuery(item: Item, query: AdvancedSearchQuery): boolean {
  if (query.conditions.length === 0) return true;
  if (query.combinator === "AND") {
    return query.conditions.every((c) => matchesCondition(item, c));
  }
  return query.conditions.some((c) => matchesCondition(item, c));
}

export function matchesKeyword(item: Item, keyword: string): boolean {
  if (!keyword.trim()) return true;
  const k = keyword.trim().toLowerCase();
  const haystacks = [
    item.name,
    item.id,
    item.barcode ?? "",
    item.notes ?? "",
    item.status ?? "",
    item.itemType ?? "",
  ];
  return haystacks.some((h) => h.toLowerCase().includes(k));
}

/** 検索条件が「検索可能な状態」かどうか(未完成な条件があればfalse)。指示書 §13-4 */
export function isSearchQueryReady(query: AdvancedSearchQuery): boolean {
  return query.conditions.every((c) => {
    if (c.type === "category" || c.type === "location") return true; // 未選択でも許容(絞り込みなし)
    if (c.operator === "range") {
      return c.value !== undefined && c.value !== null && c.value !== "" &&
        c.valueTo !== undefined && c.valueTo !== null && c.valueTo !== "";
    }
    return c.value !== undefined && c.value !== null && c.value !== "";
  });
}

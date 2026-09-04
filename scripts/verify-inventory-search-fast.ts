/**
 * 検索の新旧突き合わせ(2026-09-04 性能改善 第2フェーズ §9)。
 *
 *   AWS_PROFILE=Bello npm run verify:inventory-search-fast
 *
 * ── 何を確かめるのか ────────────────────────────────────────────
 *
 * 検索の高速化は「速くなったか」だけでは採用できない。**同じ結果が
 * 返ることの証明**とセットでなければ、静かに検索漏れが出る。
 *
 * このスクリプトは Staging の実在庫をそのまま使い、
 *
 *   旧: 在庫を**全列**読んでからアプリ側で絞り込む(従来の
 *       fetchAllInventoryRecords と同じ手順を、この場で再現したもの)
 *   新: lib/inventory/inventorySearchFast.ts の searchInventoryFast
 *       (検索に要る列だけを並列Scanで読み、表示する行だけを実体化する)
 *
 * を同じ検索条件へ通し、
 *
 *   ・総件数            total
 *   ・ページに出る行のID と その順序
 *   ・行の中身          (BatchGetItem で取り直した項目が、全列走査で
 *                        読んだ項目と1属性も違わないこと)
 *
 * が完全に一致することを確かめる。1つでも違えば失敗として落とす。
 *
 * 読み取り専用(Scan と BatchGetItem のみ)。
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";
import {
  STATIC_SEARCH_FIELDS,
  evaluateQuery,
  matchesQuickSearch,
  type AdvancedSearchQuery,
  type SearchFieldDef,
  type SearchableRecord,
} from "@/lib/inventory/advancedSearch";
import { resolveDisplayInventoryId } from "@/lib/inventory/inventoryId";
import { ensureConversationTableName } from "./lib/resolveStagingTables";

const REGION = process.env.AWS_REGION || "us-west-2";
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

let failures = 0;
let passes = 0;
function check(ok: boolean, label: string, detail = "") {
  if (ok) {
    passes++;
    console.log(`✓ ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    failures++;
    console.error(`✗ FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

type RawItem = Record<string, unknown>;

/** 従来経路と同じ形の判定用レコードを、全列の生データから作る。 */
function toReferenceRecord(raw: RawItem): SearchableRecord & { id: string; updatedAt: string } {
  let customFields: Record<string, unknown> | null = null;
  const cf = raw.customFields;
  if (cf && typeof cf === "object") customFields = cf as Record<string, unknown>;
  else if (typeof cf === "string" && cf.trim() !== "") {
    try {
      const parsed = JSON.parse(cf);
      if (parsed && typeof parsed === "object") customFields = parsed as Record<string, unknown>;
    } catch {
      customFields = null;
    }
  }
  return {
    ...raw,
    displayId: resolveDisplayInventoryId({
      sourceSystem: (raw.sourceSystem as string | null | undefined) ?? null,
      sourceInventoryId: (raw.sourceInventoryId as string | null | undefined) ?? null,
      sku: raw.sku as string,
    }),
    quantity: (raw.quantity as number | null | undefined) ?? 0,
    customFields,
    id: raw.id as string,
    updatedAt: raw.updatedAt as string,
  };
}

/**
 * キーの並び順に依存しない比較用の文字列。
 *
 * Scan と BatchGetItem は同じ項目でも属性の**順序**が違うことがある。
 * JSON.stringify をそのまま突き合わせると、中身が同一でも不一致になる。
 */
function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
}

function compareByUpdatedAtDesc(a: { id: string; updatedAt: string }, b: { id: string; updatedAt: string }): number {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1;
  return a.id < b.id ? 1 : -1;
}

/** 旧経路の再現: 非削除の在庫を全列読む。 */
async function scanAllFullColumns(table: string): Promise<RawItem[]> {
  const items: RawItem[] = [];
  let key: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(
      new ScanCommand({ TableName: table, FilterExpression: "attribute_not_exists(deletedAt)", ExclusiveStartKey: key }),
    );
    items.push(...((res.Items ?? []) as RawItem[]));
    key = res.LastEvaluatedKey;
  } while (key);
  return items;
}

interface Case {
  label: string;
  input: {
    filters?: { categoryIds?: string[]; locationId?: string; statusId?: string };
    q?: string;
    advanced?: { query: AdvancedSearchQuery; fieldsByKey: Map<string, SearchFieldDef> };
  };
  offset: number;
  limit: number;
}

async function main() {
  const table = await ensureConversationTableName();
  const { searchInventoryFast } = await import("@/lib/inventory/inventorySearchFast");
  const { directTableName } = await import("@/lib/amplify/directData");
  const inventoryTable = directTableName("Inventory");
  console.log(`[verify-inventory-search-fast] ${inventoryTable} (env経由: ${table})`);

  const t0 = Date.now();
  const allRaw = await scanAllFullColumns(inventoryTable);
  const allRecords = allRaw.map(toReferenceRecord);
  const rawById = new Map(allRaw.map((r) => [r.id as string, r]));
  console.log(`[verify-inventory-search-fast] 参照用の全列走査: ${allRecords.length}件 / ${Date.now() - t0}ms\n`);

  const fieldsByKey = new Map(STATIC_SEARCH_FIELDS.map((f) => [f.key, f]));
  // 動的な追加項目(customFields)も1つ拾って対象に入れる。
  const cfKey = (() => {
    for (const r of allRecords) {
      const keys = Object.keys(r.customFields ?? {});
      const withValue = keys.find((k) => String((r.customFields as Record<string, unknown>)[k] ?? "").trim() !== "");
      if (withValue) return withValue;
    }
    return null;
  })();
  if (cfKey) {
    fieldsByKey.set(`cf:${cfKey}`, { key: `cf:${cfKey}`, label: cfKey, group: "追加項目", valueType: "string" });
  }

  // 実在する値から条件を作る(存在しないIDで0件同士が一致しても意味が無い)。
  const someCategory = allRecords.find((r) => r.categoryId)?.categoryId as string | undefined;
  const otherCategory = allRecords.find((r) => r.categoryId && r.categoryId !== someCategory)?.categoryId as string | undefined;
  const someLocation = allRecords.find((r) => r.locationId)?.locationId as string | undefined;
  const someStatus = allRecords.find((r) => r.statusId)?.statusId as string | undefined;
  const someName = String(allRecords.find((r) => String(r.name ?? "").length >= 4)?.name ?? "");
  const nameFragment = someName.slice(1, 4);
  const someSku = String(allRecords.find((r) => r.sku)?.sku ?? "");
  const someDisplayId = String(allRecords.find((r) => r.displayId)?.displayId ?? "");
  const someSaleEnd = String(allRecords.find((r) => r.saleEndDate)?.saleEndDate ?? "").slice(0, 10);
  const cfValue = cfKey
    ? String(
        (allRecords.find((r) => String((r.customFields as Record<string, unknown> | null)?.[cfKey] ?? "").trim() !== "")
          ?.customFields as Record<string, unknown>)[cfKey],
      ).slice(0, 3)
    : null;

  type ConditionInput = Omit<AdvancedSearchQuery["conditions"][number], "id">;
  const adv = (combinator: "AND" | "OR", conditions: ConditionInput[]): Case["input"]["advanced"] => ({
    query: { combinator, conditions: conditions.map((c, i) => ({ ...c, id: `c${i}` })) },
    fieldsByKey,
  });

  const cases: Case[] = [
    // ── クイック検索 ──────────────────────────────────────────
    { label: "クイック検索: 空(絞り込みなし)", input: {}, offset: 0, limit: 50 },
    { label: "クイック検索: 商品名の一部", input: { q: nameFragment }, offset: 0, limit: 50 },
    { label: "クイック検索: 商品名の一部(大文字化)", input: { q: nameFragment.toUpperCase() }, offset: 0, limit: 50 },
    { label: "クイック検索: 商品名の一部(小文字化)", input: { q: nameFragment.toLowerCase() }, offset: 0, limit: 50 },
    { label: "クイック検索: SKU完全", input: { q: someSku }, offset: 0, limit: 50 },
    { label: "クイック検索: 在庫ID完全", input: { q: someDisplayId }, offset: 0, limit: 50 },
    { label: "クイック検索: 在庫IDの一部", input: { q: someDisplayId.slice(-4) }, offset: 0, limit: 50 },
    { label: "クイック検索: 該当なし", input: { q: "__zzz-no-such-item-zzz__" }, offset: 0, limit: 50 },
    { label: "クイック検索: 2ページ目", input: { q: nameFragment }, offset: 50, limit: 50 },
    { label: "クイック検索: 3ページ目", input: { q: nameFragment }, offset: 100, limit: 50 },
    { label: "クイック検索: 全件の2ページ目", input: {}, offset: 50, limit: 50 },
    { label: "クイック検索: 全件の末尾付近", input: {}, offset: 5000, limit: 50 },
    // ── サイドバーの絞り込み ─────────────────────────────────
    ...(someCategory ? [{ label: "絞り込み: カテゴリ1件", input: { filters: { categoryIds: [someCategory] } }, offset: 0, limit: 50 }] : []),
    ...(someCategory && otherCategory
      ? [{ label: "絞り込み: カテゴリ2件(OR)", input: { filters: { categoryIds: [someCategory, otherCategory] } }, offset: 0, limit: 50 }]
      : []),
    ...(someLocation ? [{ label: "絞り込み: 保管場所", input: { filters: { locationId: someLocation } }, offset: 0, limit: 50 }] : []),
    ...(someStatus ? [{ label: "絞り込み: ステータス", input: { filters: { statusId: someStatus } }, offset: 0, limit: 50 }] : []),
    ...(someCategory && someLocation
      ? [{ label: "絞り込み: カテゴリ+保管場所(AND)", input: { filters: { categoryIds: [someCategory], locationId: someLocation } }, offset: 0, limit: 50 }]
      : []),
    ...(someCategory
      ? [{ label: "絞り込み: カテゴリ + クイック検索", input: { filters: { categoryIds: [someCategory] }, q: nameFragment }, offset: 0, limit: 50 }]
      : []),
    { label: "絞り込み: 存在しないカテゴリ(0件)", input: { filters: { categoryIds: ["__not-a-real-id__"] } }, offset: 0, limit: 50 },
    // ── 詳細検索 ─────────────────────────────────────────────
    { label: "詳細: 商品名 contains", input: { advanced: adv("AND", [{ field: "name", operator: "contains", value: nameFragment }]) }, offset: 0, limit: 50 },
    { label: "詳細: 商品名 notContains", input: { advanced: adv("AND", [{ field: "name", operator: "notContains", value: nameFragment }]) }, offset: 0, limit: 50 },
    { label: "詳細: 商品名 startsWith", input: { advanced: adv("AND", [{ field: "name", operator: "startsWith", value: someName.slice(0, 2) }]) }, offset: 0, limit: 50 },
    { label: "詳細: 商品名 equals", input: { advanced: adv("AND", [{ field: "name", operator: "equals", value: someName }]) }, offset: 0, limit: 50 },
    { label: "詳細: 在庫ID contains", input: { advanced: adv("AND", [{ field: "displayId", operator: "contains", value: someDisplayId.slice(-4) }]) }, offset: 0, limit: 50 },
    { label: "詳細: 備考 isEmpty", input: { advanced: adv("AND", [{ field: "note", operator: "isEmpty" }]) }, offset: 0, limit: 50 },
    { label: "詳細: 備考 isNotEmpty", input: { advanced: adv("AND", [{ field: "note", operator: "isNotEmpty" }]) }, offset: 0, limit: 50 },
    { label: "詳細: 傷汚れメモ isNotEmpty", input: { advanced: adv("AND", [{ field: "damageNotes", operator: "isNotEmpty" }]) }, offset: 0, limit: 50 },
    { label: "詳細: 管理メモ isNotEmpty", input: { advanced: adv("AND", [{ field: "adminMemo", operator: "isNotEmpty" }]) }, offset: 0, limit: 50 },
    { label: "詳細: 数量 eq 0", input: { advanced: adv("AND", [{ field: "quantity", operator: "eq", value: "0" }]) }, offset: 0, limit: 50 },
    { label: "詳細: 数量 isEmpty", input: { advanced: adv("AND", [{ field: "quantity", operator: "isEmpty" }]) }, offset: 0, limit: 50 },
    { label: "詳細: 購入価格 ge", input: { advanced: adv("AND", [{ field: "purchasePrice", operator: "ge", value: "10000" }]) }, offset: 0, limit: 50 },
    { label: "詳細: 販売価格 between", input: { advanced: adv("AND", [{ field: "salePrice", operator: "between", value: "1000", value2: "50000" }]) }, offset: 0, limit: 50 },
    { label: "詳細: 幅 isNotEmpty", input: { advanced: adv("AND", [{ field: "width", operator: "isNotEmpty" }]) }, offset: 0, limit: 50 },
    ...(someSaleEnd
      ? [
          { label: "詳細: 販売終了日 on", input: { advanced: adv("AND", [{ field: "saleEndDate", operator: "on", value: someSaleEnd }]) }, offset: 0, limit: 50 },
          { label: "詳細: 販売終了日 after", input: { advanced: adv("AND", [{ field: "saleEndDate", operator: "after", value: someSaleEnd }]) }, offset: 0, limit: 50 },
          { label: "詳細: 販売終了日 before", input: { advanced: adv("AND", [{ field: "saleEndDate", operator: "before", value: someSaleEnd }]) }, offset: 0, limit: 50 },
        ]
      : []),
    { label: "詳細: 作成日 after", input: { advanced: adv("AND", [{ field: "createdAt", operator: "after", value: "2020-01-01" }]) }, offset: 0, limit: 50 },
    ...(someCategory ? [{ label: "詳細: カテゴリ equals", input: { advanced: adv("AND", [{ field: "categoryId", operator: "equals", value: someCategory }]) }, offset: 0, limit: 50 }] : []),
    ...(someLocation ? [{ label: "詳細: 保管場所 equals", input: { advanced: adv("AND", [{ field: "locationId", operator: "equals", value: someLocation }]) }, offset: 0, limit: 50 }] : []),
    ...(someStatus ? [{ label: "詳細: 状態 equals", input: { advanced: adv("AND", [{ field: "statusId", operator: "equals", value: someStatus }]) }, offset: 0, limit: 50 }] : []),
    ...(cfKey && cfValue
      ? [
          { label: `詳細: 追加項目 ${cfKey} contains`, input: { advanced: adv("AND", [{ field: `cf:${cfKey}`, operator: "contains", value: cfValue }]) }, offset: 0, limit: 50 },
          { label: `詳細: 追加項目 ${cfKey} isNotEmpty`, input: { advanced: adv("AND", [{ field: `cf:${cfKey}`, operator: "isNotEmpty" }]) }, offset: 0, limit: 50 },
        ]
      : []),
    {
      label: "詳細: AND 2条件(商品名 + 備考あり)",
      input: { advanced: adv("AND", [{ field: "name", operator: "contains", value: nameFragment }, { field: "note", operator: "isNotEmpty" }]) },
      offset: 0,
      limit: 50,
    },
    {
      label: "詳細: OR 2条件(商品名 or 傷汚れメモあり)",
      input: { advanced: adv("OR", [{ field: "name", operator: "contains", value: nameFragment }, { field: "damageNotes", operator: "isNotEmpty" }]) },
      offset: 0,
      limit: 50,
    },
    {
      label: "詳細: AND 3条件(名前 + 価格 + 日付)",
      input: {
        advanced: adv("AND", [
          { field: "name", operator: "contains", value: nameFragment },
          { field: "purchasePrice", operator: "ge", value: "1" },
          { field: "createdAt", operator: "after", value: "2020-01-01" },
        ]),
      },
      offset: 0,
      limit: 50,
    },
    { label: "詳細: 条件なし(全件と同じになるべき)", input: { advanced: adv("AND", []) }, offset: 0, limit: 50 },
    { label: "詳細: 該当なし", input: { advanced: adv("AND", [{ field: "name", operator: "equals", value: "__zzz-no-such-item-zzz__" }]) }, offset: 0, limit: 50 },
    { label: "詳細: 2ページ目", input: { advanced: adv("AND", [{ field: "note", operator: "isNotEmpty" }]) }, offset: 50, limit: 50 },
  ];

  for (const c of cases) {
    // 旧: 全列を読んだレコードに対して、同じ判定関数を通す。
    const q = c.input.q?.trim();
    const f = c.input.filters ?? {};
    const referenceFiltered = allRecords
      .filter((r) => {
        if (f.categoryIds && f.categoryIds.length > 0 && !f.categoryIds.includes(r.categoryId as string)) return false;
        if (f.locationId && r.locationId !== f.locationId) return false;
        if (f.statusId && r.statusId !== f.statusId) return false;
        if (c.input.advanced && !evaluateQuery(r, c.input.advanced.query, c.input.advanced.fieldsByKey)) return false;
        if (q && !matchesQuickSearch(r, q)) return false;
        return true;
      })
      .sort(compareByUpdatedAtDesc);
    const referencePage = referenceFiltered.slice(c.offset, c.offset + c.limit);

    // 新: 実際の高速経路。
    const fast = await searchInventoryFast(c.input, { offset: c.offset, limit: c.limit });
    if (!fast) {
      check(false, c.label, "高速経路が null を返した（従来経路へ落ちる状態）");
      continue;
    }

    const expectedIds = referencePage.map((r) => r.id);
    const actualIds = fast.rawItems.map((r) => r.id as string);
    const sameTotal = fast.total === referenceFiltered.length;
    const sameIds = JSON.stringify(actualIds) === JSON.stringify(expectedIds);
    // 行の中身: BatchGetItem で取り直した項目が全列走査のものと一致するか。
    const contentMismatch = fast.rawItems.find(
      (item) => stableJson(item) !== stableJson(rawById.get(item.id as string)),
    );

    check(
      sameTotal && sameIds && !contentMismatch,
      c.label,
      sameTotal && sameIds && !contentMismatch
        ? `${fast.total}件 / このページ${actualIds.length}件`
        : [
            sameTotal ? "" : `件数 期待${referenceFiltered.length} 実際${fast.total}`,
            sameIds ? "" : `ID/順序が不一致（期待${expectedIds.length}件 実際${actualIds.length}件）`,
            contentMismatch ? `行の中身が不一致: ${String(contentMismatch.id)}` : "",
          ]
            .filter(Boolean)
            .join(" / "),
    );
  }

  console.log(`\n合格 ${passes} / 失敗 ${failures}`);
  process.exit(failures > 0 ? 1 : 0);
}

void main().catch((err) => {
  console.error(`[verify-inventory-search-fast] 失敗: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});

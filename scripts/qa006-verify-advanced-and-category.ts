/**
 * QA-006 検証: 「詳細検索(adv) の結果 と サイドバーのカテゴリ/保管場所
 * 絞り込み」がANDで組み合わさること(URLだけ保持して結果には反映され
 * ない、という見せかけの修正になっていないこと)を確認する。
 *
 * lib/inventory/queries.ts の listInventoryAdvanced 自体は "server-only"
 * / AWS SDK に依存しており、node_modulesの無いこの環境では直接importで
 * きない。ここでは、そのslow-path(fetchAllInventoryRecords以降)に実際
 * に書いたロジック——
 *
 *   const conditions = categoryIds→{or:[...]}, locationId→{eq}
 *   const all = await fetchAllInventoryRecords(conditions)   // DB側でAND
 *   const filtered = all.filter(r => evaluateQuery(r, query, fieldsByKey)) // JS側でAND
 *
 * ——のうち、依存ゼロで再現できる部分(evaluateQueryは実物をそのまま
 * import、DB側条件の組み立てとAND適用はqueries.tsと一字一句同じロジッ
 * クをここに複製)を実データ相当のフィクスチャで検証する。
 *
 * 実行: node --experimental-strip-types scripts/qa006-verify-advanced-and-category.ts
 */
import { evaluateQuery, type SearchFieldDef, type SearchableRecord, type AdvancedSearchQuery } from "../lib/inventory/advancedSearch.ts";

const fieldDefs: SearchFieldDef[] = [
  { key: "displayId", label: "在庫ID", group: "基本情報", valueType: "string" },
  { key: "categoryId", label: "カテゴリ", group: "基本情報", valueType: "category" },
  { key: "locationId", label: "保管場所", group: "基本情報", valueType: "location" },
];
const fieldsByKey = new Map(fieldDefs.map((f) => [f.key, f]));

interface Row extends SearchableRecord {
  id: string;
  displayId: string;
  categoryId: string | null;
  locationId: string | null;
}

// 実機repro相当のフィクスチャ: B000002がチェア以外のカテゴリにいる
// ケース(2件はB000002を含むがカテゴリ違い、1件はチェアだがB000002を
// 含まない)。
const rows: Row[] = [
  { id: "1", displayId: "B000002", categoryId: "cat-sofa", locationId: "loc-a", customFields: null }, // advには一致するがカテゴリが違う(実機reproの核心)
  { id: "2", displayId: "B0000021", categoryId: "cat-chair", locationId: "loc-b", customFields: null }, // adv・カテゴリには一致するが保管場所が違う
  { id: "3", displayId: "X000099", categoryId: "cat-chair", locationId: "loc-b", customFields: null }, // カテゴリは一致するがadvに一致しない(「別商品を含む一覧」問題の原因行)
  { id: "4", displayId: "B000002-alt", categoryId: "cat-chair", locationId: "loc-a", customFields: null }, // adv・カテゴリ・保管場所すべてに一致する唯一の行
];

const advQuery: AdvancedSearchQuery = {
  combinator: "AND",
  conditions: [{ id: "c1", field: "displayId", operator: "contains", value: "B000002" }],
};

/** queries.ts の listInventoryAdvanced のslow-pathと同じ組み立て(DB側条件相当)。 */
function matchesExtraFilters(row: Row, extraFilters: { categoryIds?: string[]; locationId?: string }): boolean {
  if (extraFilters.categoryIds && extraFilters.categoryIds.length > 0) {
    if (!row.categoryId || !extraFilters.categoryIds.includes(row.categoryId)) return false;
  }
  if (extraFilters.locationId && row.locationId !== extraFilters.locationId) return false;
  return true;
}

/** queries.ts の listInventoryAdvanced と一字一句同じ組み合わせ順(DB側extraFilters → JS側evaluateQuery、両方ANDで通ったものだけ残す)。 */
function listInventoryAdvancedLogic(query: AdvancedSearchQuery, extraFilters: { categoryIds?: string[]; locationId?: string }): Row[] {
  return rows.filter((r) => matchesExtraFilters(r, extraFilters)).filter((r) => evaluateQuery(r, query, fieldsByKey));
}

let failures = 0;
function assertIds(actual: Row[], expectedIds: string[], label: string) {
  const actualIds = actual.map((r) => r.id).sort();
  const exp = [...expectedIds].sort();
  if (JSON.stringify(actualIds) !== JSON.stringify(exp)) {
    failures++;
    console.error(`NG  ${label}\n    expected ids: ${exp.join(",")}\n    actual ids:   ${actualIds.join(",")}`);
  } else {
    console.log(`OK  ${label} (ids: ${actualIds.join(",") || "(none)"})`);
  }
}

// 1. カテゴリ絞り込み無し = 従来どおりadvだけで判定(1,2,4が一致)。
assertIds(listInventoryAdvancedLogic(advQuery, {}), ["1", "2", "4"], "絞り込み無し: advだけで一致する行を返す");

// 2. 実機repro: 「チェア」を選んでも、advのB000002条件との両方に一致する行だけを返す(2と4。1は除外)。
assertIds(
  listInventoryAdvancedLogic(advQuery, { categoryIds: ["cat-chair"] }),
  ["2", "4"],
  "QA-006: カテゴリ『チェア』選択時、advとカテゴリの両方に一致する行だけを返す(見せかけの絞り込みではない)",
);

// 3. 保管場所も同時に絞り込めばさらに絞られる(2は除外、4だけが残る)。
assertIds(
  listInventoryAdvancedLogic(advQuery, { categoryIds: ["cat-chair"], locationId: "loc-a" }),
  ["4"],
  "カテゴリ+保管場所+advの3条件すべてに一致する行だけを返す",
);

// 4. adv一致行が1件も無いカテゴリ(lamp、フィクスチャに存在しない)を選べば0件
//    (「絞り込み結果が両条件に一致する」= カテゴリ内の無関係な商品を混ぜない)。
assertIds(
  listInventoryAdvancedLogic(advQuery, { categoryIds: ["cat-lamp"] }),
  [],
  "adv条件に一致する行が無いカテゴリを選ぶと0件(カテゴリ内の無関係な商品を混ぜない)",
);

if (failures > 0) {
  console.error(`\n${failures}件失敗`);
  process.exit(1);
}
console.log("\n全件成功");

/**
 * 検索の Golden Test(2026-09-02 指示書§9〜§14)。
 *
 * 高速化は**精度を落とさないことの証明**とセットでなければ採用できない。
 * このスクリプトは Staging の実在庫 5,313件をそのまま使い、
 *
 *   A. 全列を読んだ場合の検索結果
 *   B. projection(検索・一覧が実際に読む列だけ)を適用した場合の検索結果
 *
 * を同じ検索エンジン(lib/inventory/advancedSearch.ts)へ通して、
 *
 *   result IDs / count / order / filter semantics
 *
 * が完全に一致することを確かめる。あわせて payload の削減量を実測する。
 *
 * 読み取り専用(DynamoDBのScanのみ)。
 *
 *   AWS_PROFILE=Bello npm run verify:search-projection
 */
import { readFileSync } from "node:fs";
import { DynamoDBClient, ListTablesCommand } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";
import {
  STATIC_SEARCH_FIELDS,
  evaluateQuery,
  matchesQuickSearch,
  type AdvancedSearchQuery,
  type SearchFieldDef,
  type SearchableRecord,
} from "@/lib/inventory/advancedSearch";
import {
  INVENTORY_SEARCH_SELECTION_SET,
  SEARCH_IMAGE_SUBFIELDS,
  SEARCH_SCALAR_FIELDS,
  isFieldInSearchProjection,
} from "@/lib/inventory/searchProjection";

const REGION = process.env.AWS_REGION || "us-west-2";
const raw = new DynamoDBClient({ region: REGION });
const ddb = DynamoDBDocumentClient.from(raw);

let failures = 0;
let passes = 0;
function check(ok: boolean, label: string, detail = "") {
  if (ok) { passes++; console.log(`✓ ${label}${detail ? ` — ${detail}` : ""}`); }
  else { failures++; console.error(`✗ FAIL ${label}${detail ? ` — ${detail}` : ""}`); }
}

let cachedNames: string[] | null = null;
async function listAllTableNames(): Promise<string[]> {
  if (cachedNames) return cachedNames;
  const names: string[] = [];
  let start: string | undefined;
  do {
    const res = await raw.send(new ListTablesCommand({ ExclusiveStartTableName: start }));
    names.push(...(res.TableNames ?? []));
    start = res.LastEvaluatedTableName;
  } while (start);
  return (cachedNames = names);
}

const REQUIRED_MODELS = ["Inventory", "ZaicoSourceLink", "ShippingRate"];
async function inventoryTable(): Promise<string> {
  if (process.env.BELLO_INVENTORY_TABLE) return process.env.BELLO_INVENTORY_TABLE;
  const names = await listAllTableNames();
  const byApiId = new Map<string, Set<string>>();
  for (const n of names) {
    const m = /^([A-Za-z0-9]+)-([a-z0-9]{20,})-/.exec(n);
    if (!m) continue;
    if (!byApiId.has(m[2])) byApiId.set(m[2], new Set());
    byApiId.get(m[2])!.add(m[1]);
  }
  const complete = [...byApiId.entries()].filter(([, s]) => REQUIRED_MODELS.every((r) => s.has(r))).map(([a]) => a);
  if (complete.length !== 1) throw new Error(`Amplify Data APIを一意に決められません(候補${complete.length}件)`);
  const hits = names.filter((n) => n.startsWith(`Inventory-${complete[0]}-`));
  if (hits.length !== 1) throw new Error("Inventory テーブルを一意に決められません");
  return hits[0];
}

type Row = Record<string, unknown>;

async function scanAll(table: string): Promise<Row[]> {
  const out: Row[] = [];
  let key: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(new ScanCommand({ TableName: table, ExclusiveStartKey: key }));
    out.push(...((res.Items ?? []) as Row[]));
    key = res.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (key);
  return out;
}

/** projection を適用した行を作る(実際に selectionSet を渡したときに返る形)。 */
function project(row: Row): Row {
  const out: Row = {};
  for (const f of SEARCH_SCALAR_FIELDS) if (f in row) out[f] = row[f];
  if (Array.isArray(row.images)) {
    out.images = (row.images as Row[]).map((img) => {
      const o: Row = {};
      for (const f of SEARCH_IMAGE_SUBFIELDS) o[f] = img?.[f] ?? null;
      return o;
    });
  }
  return out;
}

function asSearchable(row: Row): SearchableRecord {
  const cf = typeof row.customFields === "string" ? safeParse(row.customFields) : (row.customFields as Record<string, unknown> | null) ?? null;
  return { ...row, customFields: cf };
}

function safeParse(raw: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value ?? null), "utf8");
}

/**
 * 検索の意味論を確かめるためのケース一式(指示書§12)。
 * 実在庫に実際にヒットする語を選んである。
 */
const FIELDS_BY_KEY = new Map<string, SearchFieldDef>(STATIC_SEARCH_FIELDS.map((f) => [f.key, f]));
let conditionId = 0;
function c(field: string, operator: string, value?: string, value2?: string) {
  return { id: String(++conditionId), field, operator: operator as never, value, value2 };
}

const GOLDEN_CASES: { label: string; query: AdvancedSearchQuery }[] = [
  { label: "商品名の部分一致", query: { combinator: "AND", conditions: [c("name", "contains", "チェア")] } },
  { label: "商品名の部分一致(英字・大文字小文字)", query: { combinator: "AND", conditions: [c("name", "contains", "hay")] } },
  { label: "商品名の完全一致(0件想定)", query: { combinator: "AND", conditions: [c("name", "equals", "存在しない商品名")] } },
  { label: "商品名の前方一致", query: { combinator: "AND", conditions: [c("name", "startsWith", "【")] } },
  { label: "商品名に含まない", query: { combinator: "AND", conditions: [c("name", "notContains", "ソファ")] } },
  { label: "SKU完全一致", query: { combinator: "AND", conditions: [c("sku", "equals", "B005611")] } },
  { label: "空欄(販売価格)", query: { combinator: "AND", conditions: [c("salePrice", "isEmpty")] } },
  { label: "空欄ではない(販売価格)", query: { combinator: "AND", conditions: [c("salePrice", "isNotEmpty")] } },
  { label: "数値の範囲(仕入価格)", query: { combinator: "AND", conditions: [c("purchasePrice", "between", "5000", "20000")] } },
  { label: "数値の以上(仕入価格)", query: { combinator: "AND", conditions: [c("purchasePrice", "ge", "50000")] } },
  { label: "日付の範囲(販売開始日)", query: { combinator: "AND", conditions: [c("saleStartDate", "dateBetween", "2026-08-01", "2026-09-30")] } },
  { label: "日付より後(販売終了日)", query: { combinator: "AND", conditions: [c("saleEndDate", "after", "2026-06-01")] } },
  { label: "AND 複数条件", query: { combinator: "AND", conditions: [c("name", "contains", "HAY"), c("purchasePrice", "ge", "5000")] } },
  { label: "OR 複数条件", query: { combinator: "OR", conditions: [c("name", "contains", "REVOLVER"), c("name", "contains", "ソファ")] } },
  { label: "寸法(幅)の部分一致", query: { combinator: "AND", conditions: [c("width", "contains", "座面")] } },
  { label: "傷メモの部分一致", query: { combinator: "AND", conditions: [c("damageNotes", "contains", "小傷")] } },
  { label: "備考の部分一致", query: { combinator: "AND", conditions: [c("note", "contains", "在庫")] } },
  { label: "市場の完全一致", query: { combinator: "AND", conditions: [c("market", "equals", "メルカリ")] } },
  { label: "商品IDの前方一致", query: { combinator: "AND", conditions: [c("externalProductId", "startsWith", "m")] } },
  { label: "記号を含む語", query: { combinator: "AND", conditions: [c("name", "contains", "/")] } },
  { label: "空白を含む語", query: { combinator: "AND", conditions: [c("name", "contains", "BAR STOOL")] } },
  { label: "コンディション評価", query: { combinator: "AND", conditions: [c("conditionRating", "equals", "4")] } },
  { label: "相手氏名の部分一致", query: { combinator: "AND", conditions: [c("counterpartyName", "contains", "オークション")] } },
  { label: "取引区分", query: { combinator: "AND", conditions: [c("transactionType", "equals", "買受")] } },
];

async function main() {
  const table = await inventoryTable();
  const all = (await scanAll(table)).filter((r) => !r.deletedAt);
  console.log(`Inventory(論理削除を除く): ${all.length}件\n`);

  // ── 1. projection が検索フィールド定義を取りこぼしていないか ────
  console.log("── 1. projection の網羅性 ──────────────────────────────");
  const staticSearchFields = STATIC_SEARCH_FIELDS.map((f) => f.key);
  const missing = staticSearchFields.filter((k) => !isFieldInSearchProjection(k));
  check(
    missing.length === 0,
    "詳細検索の全フィールドが projection に含まれている",
    missing.length ? `欠落: ${missing.join(", ")}` : `${staticSearchFields.length}項目`,
  );
  check(
    isFieldInSearchProjection("customFields"),
    "動的な追加項目(customFields)は丸ごと projection に含まれている",
  );
  check(
    !isFieldInSearchProjection("images.sourceUrl") && !isFieldInSearchProjection("images.originalHash"),
    "一覧・検索が使わない画像の子フィールドは projection から外れている",
  );
  console.log(`   selectionSet: ${INVENTORY_SEARCH_SELECTION_SET.length}項目`);

  // projection に、Inventory に実在しない列が混ざっていないか。
  // 混ざっていると AppSync が GraphQL のバリデーションで丸ごと落とす
  // ——「一覧が真っ白になる」という形で表に出るので、静かではないが致命的。
  // amplify/data/resource.ts の Inventory モデル定義そのものと突き合わせる。
  const schemaSource = readFileSync("amplify/data/resource.ts", "utf8");
  const inventoryBlock = schemaSource.slice(
    schemaSource.indexOf("  Inventory: a"),
    schemaSource.indexOf("  InventoryHistory: a"),
  );
  const declared = new Set<string>();
  for (const m of inventoryBlock.matchAll(/^\s{6}([a-zA-Z][a-zA-Z0-9]*):\s*a\./gm)) declared.add(m[1]);
  // Amplify が自動で持つ列(モデル定義には書かれない)。
  for (const f of ["id", "createdAt", "updatedAt"]) declared.add(f);
  const notInSchema = SEARCH_SCALAR_FIELDS.filter((f) => !declared.has(f));
  check(
    notInSchema.length === 0,
    "projection の全列が Inventory モデルに実在する",
    notInSchema.length ? `実在しない: ${notInSchema.join(", ")}` : `${SEARCH_SCALAR_FIELDS.length}列 / モデル定義 ${declared.size}列`,
  );

  // ── 2. Golden: 検索結果が一致するか ─────────────────────────────
  console.log("\n── 2. 検索結果の一致(全列 vs projection) ────────────────");
  const projected = all.map(project);
  let totalHits = 0;
  for (const gc of GOLDEN_CASES) {
    const before = all.filter((r) => evaluateQuery(asSearchable(r), gc.query, FIELDS_BY_KEY)).map((r) => r.id as string);
    const after = projected.filter((r) => evaluateQuery(asSearchable(r), gc.query, FIELDS_BY_KEY)).map((r) => r.id as string);
    totalHits += before.length;
    const same = before.length === after.length && before.every((id, i) => id === after[i]);
    check(same, gc.label, `${before.length}件` + (same ? "" : ` / after ${after.length}件`));
  }
  check(totalHits > 0, "Goldenケース全体で1件以上ヒットしている(空振りのテストになっていない)", `のべ${totalHits}件`);

  // ── 3. payload の削減量(実測) ──────────────────────────────────
  console.log("\n── 3. 転送量(実測) ─────────────────────────────────────");
  const beforeBytes = all.reduce((s, r) => s + bytes(r), 0);
  const afterBytes = projected.reduce((s, r) => s + bytes(r), 0);
  const imagesBefore = all.reduce((s, r) => s + bytes(r.images), 0);
  const imagesAfter = projected.reduce((s, r) => s + bytes(r.images), 0);
  const kb = (n: number) => `${(n / 1024).toFixed(0)}KB`;
  console.log(`   全列          : ${kb(beforeBytes)}`);
  console.log(`   projection    : ${kb(afterBytes)}  (${((1 - afterBytes / beforeBytes) * 100).toFixed(1)}% 削減)`);
  console.log(`   うち images   : ${kb(imagesBefore)} → ${kb(imagesAfter)}  (${((1 - imagesAfter / imagesBefore) * 100).toFixed(1)}% 削減)`);
  check(afterBytes < beforeBytes, "projection のほうが小さい", `${kb(beforeBytes)} → ${kb(afterBytes)}`);

  // 削減率が小さすぎるなら、そもそも入れる意味が無い。5%を下回ったら知らせる。
  check(
    1 - afterBytes / beforeBytes >= 0.05,
    "削減率が5%以上ある(入れる価値がある変更である)",
    `${((1 - afterBytes / beforeBytes) * 100).toFixed(1)}%`,
  );

  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });

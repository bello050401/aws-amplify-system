/**
 * 売上集計の Golden Test(2026-09-02 指示書§18)。
 *
 * 高速化で金額が1円でも変わってはいけない。Staging の実在庫を使い、
 *
 *   A. 現行ロジック(全件を読んで summarizeSales で毎回集計)
 *   B. 新方式(月次集計 read model)
 *
 * の数値が**完全に一致**することを確かめる。
 *
 * 読み取り専用(DynamoDBのScanのみ)。集計テーブルへの書き込みは
 * scripts/rebuild-sales-aggregate.ts が行う。
 *
 *   AWS_PROFILE=Bello npm run verify:sales-aggregate
 */
import { DynamoDBClient, ListTablesCommand } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { summarizeSales, summarizeMonthlyTrend, type SalesSourceRecord } from "@/lib/inventory/sales";
import {
  buildMonthlyAggregates,
  compareAggregates,
  formatYearMonth,
  parseYearMonth,
  totalsFromAggregate,
  yearMonthOf,
} from "@/lib/inventory/salesAggregate";

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

interface InvRow {
  id: string;
  sku: string;
  name: string;
  saleEndDate?: string | null;
  salePrice?: number | null;
  purchasePrice?: number | null;
  shippingCost?: number | null;
  deletedAt?: string | null;
}

async function scanAll(table: string): Promise<InvRow[]> {
  const out: InvRow[] = [];
  let key: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(
      new ScanCommand({
        TableName: table,
        ProjectionExpression: "id, sku, #n, saleEndDate, salePrice, purchasePrice, shippingCost, deletedAt",
        ExpressionAttributeNames: { "#n": "name" },
        ExclusiveStartKey: key,
      }),
    );
    out.push(...((res.Items ?? []) as InvRow[]));
    key = res.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (key);
  return out;
}

async function main() {
  const table = await inventoryTable();
  const rows = (await scanAll(table)).filter((r) => !r.deletedAt);
  const records: SalesSourceRecord[] = rows.map((r) => ({
    id: r.id,
    displayId: r.sku,
    sku: r.sku,
    name: r.name,
    saleEndDate: r.saleEndDate ?? null,
    salePrice: r.salePrice ?? null,
    purchasePrice: r.purchasePrice ?? null,
    shippingCost: r.shippingCost ?? null,
  }));

  const withSale = records.filter((r) => r.saleEndDate);
  console.log(`Inventory(論理削除を除く): ${records.length}件 / 販売終了日あり ${withSale.length}件 (${((withSale.length / records.length) * 100).toFixed(0)}%)\n`);

  // ── 1. 集計を作る ──────────────────────────────────────────────
  const aggregates = buildMonthlyAggregates(records);
  const byMonth = new Map(aggregates.map((a) => [a.yearMonth, a]));
  console.log(`── 1. 集計 ─────────────────────────────────────────────`);
  console.log(`   集計された月数: ${aggregates.length}`);
  check(aggregates.length > 0, "集計対象の月が1つ以上ある");

  const totalCounted = aggregates.reduce((s, a) => s + a.count, 0);
  check(
    totalCounted === withSale.length,
    "集計に入った件数の合計が、販売終了日を持つ在庫の件数と一致する",
    `${totalCounted} / ${withSale.length}`,
  );

  // ── 2. Golden: 現行ロジックと1円まで一致するか ─────────────────
  console.log(`\n── 2. 現行ロジックとの一致(月ごと) ───────────────────`);
  const months = aggregates.map((a) => a.yearMonth);
  // 全月を検査する。「当月/前月/任意月」だけでなく全部見る —— 一致しない
  // 月が1つでもあれば表示を切り替えてはいけない。
  let mismatched = 0;
  for (const ym of months) {
    const parsed = parseYearMonth(ym)!;
    const live = summarizeSales(records, parsed.year, parsed.month);
    const fromAggregate = totalsFromAggregate(byMonth.get(ym) ?? null, parsed.year, parsed.month);
    const same =
      live.count === fromAggregate.count &&
      live.totalSales === fromAggregate.totalSales &&
      live.totalPurchase === fromAggregate.totalPurchase &&
      live.totalShipping === fromAggregate.totalShipping &&
      live.totalCost === fromAggregate.totalCost &&
      live.totalProfit === fromAggregate.totalProfit &&
      live.costRate === fromAggregate.costRate &&
      live.averageSalePrice === fromAggregate.averageSalePrice;
    if (!same) {
      mismatched++;
      console.error(
        `✗ ${ym}: live=${JSON.stringify({ c: live.count, s: live.totalSales, p: live.totalProfit })} ` +
          `agg=${JSON.stringify({ c: fromAggregate.count, s: fromAggregate.totalSales, p: fromAggregate.totalProfit })}`,
      );
    }
  }
  check(mismatched === 0, `全${months.length}ヶ月で現行ロジックと完全一致(件数・売上・購入・送料・原価・粗利・原価率・平均単価)`);

  // ── 3. 売上が0の月・存在しない月 ───────────────────────────────
  console.log(`\n── 3. 境界 ─────────────────────────────────────────────`);
  const empty = totalsFromAggregate(null, 1990, 1);
  const liveEmpty = summarizeSales(records, 1990, 1);
  check(
    empty.count === liveEmpty.count && empty.totalSales === liveEmpty.totalSales && empty.costRate === liveEmpty.costRate,
    "売上が1件も無い月は、現行ロジックと同じく0で返る(0除算しない)",
  );
  check(yearMonthOf(null) === null, "販売終了日が無いレコードは集計対象外");
  check(yearMonthOf("2026-09-30") === "2026-09", "販売終了日から年月を取り出す");
  check(yearMonthOf("2026-09-30T15:00:00Z") === "2026-09", "日時形式でも文字列の先頭7文字だけを見る(タイムゾーンでずらさない)");
  check(formatYearMonth(2026, 9) === "2026-09", "年月の書式");

  // ── 4. 12ヶ月推移が一致するか ──────────────────────────────────
  console.log(`\n── 4. 12ヶ月推移 ───────────────────────────────────────`);
  const latest = months[months.length - 1];
  const { year: ly, month: lm } = parseYearMonth(latest)!;
  const liveTrend = summarizeMonthlyTrend(records, ly, lm, 12);
  let trendMismatch = 0;
  for (const point of liveTrend) {
    const ym = formatYearMonth(point.year, point.month);
    const agg = totalsFromAggregate(byMonth.get(ym) ?? null, point.year, point.month);
    // MonthlyTrendPoint が持つのは売上高と粗利益だけ(件数は持たない)。
    // 比較するのもその2つに揃える。
    if (point.totalSales !== agg.totalSales || point.totalGrossProfit !== agg.totalProfit) {
      trendMismatch++;
      console.error(
        `✗ ${ym}: live sales=${point.totalSales} profit=${point.totalGrossProfit} / ` +
          `agg sales=${agg.totalSales} profit=${agg.totalProfit}`,
      );
    }
  }
  check(trendMismatch === 0, "12ヶ月推移も現行ロジックと一致", `${liveTrend.length}ヶ月`);

  // ── 5. 冪等性 ──────────────────────────────────────────────────
  console.log(`\n── 5. 冪等性と drift 検出 ──────────────────────────────`);
  const again = buildMonthlyAggregates(records);
  check(compareAggregates(aggregates, again).length === 0, "同じ入力から何度作っても同じ結果になる(idempotent)");

  // 1件だけ売上を変えたら、その月にだけ drift が出る。
  const target = withSale[0];
  const mutated = records.map((r) => (r.id === target.id ? { ...r, salePrice: (r.salePrice ?? 0) + 1 } : r));
  const drift = compareAggregates(aggregates, buildMonthlyAggregates(mutated));
  const targetMonth = yearMonthOf(target.saleEndDate)!;
  check(drift.length > 0, "1円の変化でも drift として検出できる", `${drift.length}件`);
  check(
    drift.every((d) => d.yearMonth === targetMonth),
    "drift はその月にだけ出る(他の月へ波及しない)",
    targetMonth,
  );

  // ── 6. 読み取り量の比較 ────────────────────────────────────────
  console.log(`\n── 6. 読み取り量 ───────────────────────────────────────`);
  const inventoryBytes = rows.reduce((s, r) => s + Buffer.byteLength(JSON.stringify(r), "utf8"), 0);
  const aggregateBytes = aggregates.reduce((s, a) => s + Buffer.byteLength(JSON.stringify(a), "utf8"), 0);
  const trendMonths = 12;
  const trendBytes = aggregates
    .slice(-trendMonths)
    .reduce((s, a) => s + Buffer.byteLength(JSON.stringify(a), "utf8"), 0);
  const kb = (n: number) => `${(n / 1024).toFixed(1)}KB`;
  console.log(`   現行: 在庫全件を読む            ${rows.length}件 / ${kb(inventoryBytes)}`);
  console.log(`   新方式: 当月1件 + 推移12件      13件 / ${kb(trendBytes)}`);
  console.log(`   (集計テーブル全体でも ${aggregates.length}件 / ${kb(aggregateBytes)})`);
  check(trendBytes < inventoryBytes / 100, "画面表示に必要な読み取り量が2桁以上小さい");

  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });

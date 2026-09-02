/**
 * 売上月次集計の再構築(2026-09-02 指示書§19)。
 *
 * 派生データなので、いつでも捨てて作り直せる。作り直しが唯一の更新手段
 * なので、加算による二重計上も、取消の取りこぼしも起きない。
 *
 * 既定は dry-run。実際に書き込むには --apply が要る。
 *
 *   AWS_PROFILE=Bello npm run rebuild:sales-aggregate
 *   AWS_PROFILE=Bello npm run rebuild:sales-aggregate -- --apply
 *
 * Production では実行しない(このスクリプトは Staging の資格情報でしか
 * 動かない前提。実行前に必ず `aws sts get-caller-identity` で確認すること)。
 */
import { DynamoDBClient, ListTablesCommand } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand, PutCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { buildMonthlyAggregates, compareAggregates, type SalesMonthlyAggregateRow } from "@/lib/inventory/salesAggregate";
import type { SalesSourceRecord } from "@/lib/inventory/sales";

const APPLY = process.argv.includes("--apply");
const REGION = process.env.AWS_REGION || "us-west-2";
const raw = new DynamoDBClient({ region: REGION });
const ddb = DynamoDBDocumentClient.from(raw);

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

const REQUIRED_MODELS = ["Inventory", "ZaicoSourceLink", "SalesMonthlyAggregate"];
async function resolveApiId(): Promise<string> {
  const names = await listAllTableNames();
  const byApiId = new Map<string, Set<string>>();
  for (const n of names) {
    const m = /^([A-Za-z0-9]+)-([a-z0-9]{20,})-/.exec(n);
    if (!m) continue;
    if (!byApiId.has(m[2])) byApiId.set(m[2], new Set());
    byApiId.get(m[2])!.add(m[1]);
  }
  const complete = [...byApiId.entries()].filter(([, s]) => REQUIRED_MODELS.every((r) => s.has(r))).map(([a]) => a);
  if (complete.length !== 1) {
    throw new Error(
      `Amplify Data APIを一意に決められません(候補${complete.length}件)。` +
        `SalesMonthlyAggregate がまだデプロイされていない可能性があります。`,
    );
  }
  return complete[0];
}
async function table(model: string): Promise<string> {
  const apiId = await resolveApiId();
  const names = await listAllTableNames();
  const hits = names.filter((n) => n.startsWith(`${model}-${apiId}-`));
  if (hits.length !== 1) throw new Error(`${model} のテーブルを一意に決められません`);
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

async function scanInventory(t: string): Promise<InvRow[]> {
  const out: InvRow[] = [];
  let key: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(
      new ScanCommand({
        TableName: t,
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

async function scanAggregates(t: string): Promise<SalesMonthlyAggregateRow[]> {
  const out: SalesMonthlyAggregateRow[] = [];
  let key: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(new ScanCommand({ TableName: t, ExclusiveStartKey: key }));
    out.push(...((res.Items ?? []) as SalesMonthlyAggregateRow[]));
    key = res.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (key);
  return out.sort((a, b) => (a.yearMonth < b.yearMonth ? -1 : 1));
}

async function main() {
  const inventoryTable = await table("Inventory");
  const aggregateTable = await table("SalesMonthlyAggregate");
  console.log(`inventory  = ${inventoryTable}`);
  console.log(`aggregate  = ${aggregateTable}`);
  console.log(APPLY ? "モード: --apply(実際に書き込みます)\n" : "モード: dry-run(書き込みません)\n");

  const rows = (await scanInventory(inventoryTable)).filter((r) => !r.deletedAt);
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

  const recomputed = buildMonthlyAggregates(records);
  const stored = await scanAggregates(aggregateTable);

  console.log(`在庫 ${records.length}件 → 集計 ${recomputed.length}ヶ月(保存済み ${stored.length}ヶ月)\n`);

  const drift = compareAggregates(stored, recomputed);
  if (drift.length === 0 && stored.length > 0) {
    console.log("保存済みの集計と、いま計算した集計は完全に一致しています(drift なし)。");
    if (!APPLY) return;
  } else if (stored.length > 0) {
    console.log(`── drift ${drift.length}件 ────────────────────────────`);
    for (const d of drift.slice(0, 40)) {
      console.log(`  ${d.yearMonth} ${String(d.field).padEnd(14)} 保存=${d.stored}  計算=${d.recomputed}`);
    }
    if (drift.length > 40) console.log(`  …他 ${drift.length - 40}件`);
    console.log("");
  }

  const now = new Date().toISOString();
  const recomputedMonths = new Set(recomputed.map((r) => r.yearMonth));
  const obsolete = stored.filter((s) => !recomputedMonths.has(s.yearMonth));

  if (!APPLY) {
    console.log(`(dry-run) 書き込む予定: ${recomputed.length}ヶ月 / 削除する予定: ${obsolete.length}ヶ月`);
    console.log(recomputed.slice(-6).map((r) => `  ${r.yearMonth}  ${r.count}件  売上${r.totalSales.toLocaleString("ja-JP")}円  粗利${r.totalProfit.toLocaleString("ja-JP")}円`).join("\n"));
    return;
  }

  for (const r of recomputed) {
    await ddb.send(
      new PutCommand({
        TableName: aggregateTable,
        Item: {
          ...r,
          sourceRecordCount: records.length,
          rebuiltAt: now,
          rebuiltBy: "rebuild-sales-aggregate script",
          createdAt: now,
          updatedAt: now,
          __typename: "SalesMonthlyAggregate",
        },
      }),
    );
  }
  // 売上がまるごと無くなった月は消す。残すと古い数字が出続ける。
  for (const o of obsolete) {
    await ddb.send(new DeleteCommand({ TableName: aggregateTable, Key: { yearMonth: o.yearMonth } }));
  }

  const after = await scanAggregates(aggregateTable);
  const remaining = compareAggregates(after, recomputed);
  console.log(`✓ ${recomputed.length}ヶ月を書き込み、${obsolete.length}ヶ月を削除しました。`);
  console.log(remaining.length === 0 ? "✓ 書き込み後の再検査も一致しました。" : `✗ 書き込み後もdriftが ${remaining.length}件 残っています。`);
  if (remaining.length > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });

/**
 * 売上月次集計の再構築(2026-09-02 指示書§19、2026-09-11 世代整合性
 * 修正)。
 *
 * 派生データなので、いつでも捨てて作り直せる。全月ぶんを1つの
 * SalesAggregateSnapshotアイテムへ1回のPutItemで書く——DynamoDBの
 * 単一アイテム書き込みは原子的なので、このスクリプトが複数月を
 * またぐ訂正を反映する最中に落ちても、新旧世代が混在した状態を
 * 残さない(前回公開された世代がそのまま残る)。
 *
 * 既定は dry-run。実際に書き込むには --apply が要る。
 *
 *   AWS_PROFILE=Bello npm run rebuild:sales-aggregate
 *   AWS_PROFILE=Bello npm run rebuild:sales-aggregate -- --apply
 *
 * Production では実行しない(このスクリプトは Staging の資格情報でしか
 * 動かない前提。実行前に必ず `aws sts get-caller-identity` で確認すること)。
 *
 * ── 初回構築(SalesAggregateSnapshotがまだ一度も書かれていない場合) ──
 *
 * `npx ampx sandbox`または通常のAmplifyデプロイで
 * SalesAggregateSnapshot/SalesAggregateRunStatusテーブルと
 * sales-aggregate-scheduler Lambda(EventBridge Schedule "every 12h")が
 * 作成される(amplify/backend.tsの配線)。デプロイ直後はスナップショット
 * が存在しないため、売上画面は全月「未集計」を表示する——このスクリプト
 * を --apply付きで手動実行するか、最初の定期実行(最大12時間待ち)を
 * 待てば解消する。
 */
import { DynamoDBClient, ListTablesCommand, ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { buildMonthlyAggregates, compareAggregates, type SalesMonthlyAggregateRow } from "@/lib/inventory/salesAggregate";
import { serializeSnapshotMonths, deserializeSnapshotMonths, SALES_AGGREGATE_SNAPSHOT_ID } from "@/lib/inventory/salesAggregateSnapshot";
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

const REQUIRED_MODELS = ["Inventory", "ZaicoSourceLink", "SalesAggregateSnapshot"];
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
        `SalesAggregateSnapshot がまだデプロイされていない可能性があります。`,
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

interface SnapshotItem {
  id: string;
  generation: string;
  monthsJson: string;
}

async function getSnapshot(t: string): Promise<{ generation: string | null; months: SalesMonthlyAggregateRow[] }> {
  const res = await ddb.send(new GetCommand({ TableName: t, Key: { id: SALES_AGGREGATE_SNAPSHOT_ID } }));
  const item = res.Item as SnapshotItem | undefined;
  if (!item) return { generation: null, months: [] };
  return { generation: item.generation, months: deserializeSnapshotMonths(item.monthsJson) };
}

async function main() {
  const inventoryTable = await table("Inventory");
  const snapshotTable = await table("SalesAggregateSnapshot");
  console.log(`inventory  = ${inventoryTable}`);
  console.log(`snapshot   = ${snapshotTable}`);
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
  const { generation: storedGeneration, months: stored } = await getSnapshot(snapshotTable);

  console.log(`在庫 ${records.length}件 → 集計 ${recomputed.length}ヶ月(現在公開中の世代: ${storedGeneration ?? "(未構築)"}、${stored.length}ヶ月)\n`);

  const drift = compareAggregates(stored, recomputed);
  if (drift.length === 0 && stored.length > 0) {
    console.log("公開中のスナップショットと、いま計算した集計は完全に一致しています(drift なし)。");
    if (!APPLY) return;
  } else if (stored.length > 0) {
    console.log(`── drift ${drift.length}件 ────────────────────────────`);
    for (const d of drift.slice(0, 40)) {
      console.log(`  ${d.yearMonth} ${String(d.field).padEnd(14)} 公開中=${d.stored}  計算=${d.recomputed}`);
    }
    if (drift.length > 40) console.log(`  …他 ${drift.length - 40}件`);
    console.log("");
  }

  if (!APPLY) {
    console.log(`(dry-run) 書き込む予定: 全${recomputed.length}ヶ月ぶんを1つのスナップショットとして公開`);
    console.log(recomputed.slice(-6).map((r) => `  ${r.yearMonth}  ${r.count}件  売上${r.totalSales.toLocaleString("ja-JP")}円  粗利${r.totalProfit.toLocaleString("ja-JP")}円`).join("\n"));
    return;
  }

  // 2026-09-11 世代整合性修正: 全月ぶんを1つのアイテムへ1回のPutItemで
  // 書く。DynamoDBの単一アイテム書き込みは原子的——このPutItemが失敗
  // しても、直前まで公開されていた世代のスナップショットは1バイトも
  // 変わらず残る(新旧世代が混在した状態は構造的に発生しない、
  // lib/inventory/salesAggregateSnapshot.ts冒頭コメント参照)。
  const generation = new Date().toISOString();
  let published = true;
  try {
    await ddb.send(
      new PutCommand({
        TableName: snapshotTable,
        Item: {
          id: SALES_AGGREGATE_SNAPSHOT_ID,
          __typename: "SalesAggregateSnapshot",
          generation,
          monthsJson: serializeSnapshotMonths(recomputed),
          sourceRecordCount: records.length,
          rebuiltAt: generation,
          rebuiltBy: "rebuild-sales-aggregate script",
          createdAt: generation,
          updatedAt: generation,
        },
        ConditionExpression: "attribute_not_exists(id) OR generation < :new",
        ExpressionAttributeValues: { ":new": generation },
      }),
    );
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) {
      published = false;
    } else {
      throw err;
    }
  }

  if (published) {
    console.log(`✓ 公開成功: 世代 ${generation} / ${recomputed.length}ヶ月。`);
  } else {
    console.log(`✗ 公開スキップ: より新しい世代が既に公開されているため(同時実行の定期Lambda等)、このスクリプトの計算結果は書き込まれませんでした。`);
    process.exit(1);
  }

  const after = await getSnapshot(snapshotTable);
  const remaining = compareAggregates(after.months, recomputed);
  console.log(remaining.length === 0 ? "✓ 書き込み後の再検査も一致しました。" : `✗ 書き込み後もdriftが ${remaining.length}件 残っています(公開直後に別の実行が上書きした可能性)。`);
  if (remaining.length > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });

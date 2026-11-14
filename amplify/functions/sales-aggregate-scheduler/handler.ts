import { ConditionalCheckFailedException, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand, GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { buildMonthlyAggregates } from "@/lib/inventory/salesAggregate";
import { buildAnalysis } from '@/lib/inventory/analysis/aggregate';
import { createAnalysisMetadataStore } from '@/lib/inventory/analysis/metadata';
import { cleanAnalysisRetention, publishAnalysis } from '@/lib/inventory/analysis/publication';
import { ANALYSIS_INVENTORY_PROJECTION } from '@/lib/inventory/analysis/publicationFormat';
import type { AnalysisSource } from '@/lib/inventory/analysis/types';
import {ensureInventoryMonth} from '@/lib/inventory/inventoryValueArchive';
import {lastClosedInventoryMonth} from '@/lib/inventory/inventoryValueCalendar';
import { normalizedCapturedSalesRecords } from "@/lib/inventory/analysis/salesProjection";
import { planScheduledZaicoDelta } from "@/lib/inventory/scheduledZaicoDelta";
import { ZAICO_SYNC_JOB_ID } from "@/lib/inventory/zaicoSyncJobId";
import {
  SALES_AGGREGATE_RUN_STATUS_ID,
  buildSuccessRunStatusFields,
  type SalesAggregateRunState,
} from "@/lib/inventory/salesAggregateFreshness";

/**
 * 売上月次集計の定期再構築(resource.ts のファイル冒頭コメント参照)。
 *
 * AppSync/GraphQL/Cognitoセッションを一切経由しない、生DynamoDB API直叩き
 * (pricing-scheduler/zaico-sync-worker/integrity-monitor と同じ形)。
 * 計算そのものは lib/inventory/salesAggregate.ts の純粋関数に委ね、ここでは
 * DBの読み書きと実行状態の記録だけを行う。
 *
 * 公開は「全月ぶんをまとめた1アイテムへの1回のPutItem」——月ごとに
 * PutItem/DeleteItemを繰り返していた旧設計(task_990版)と違い、書き込みが
 * 途中で失敗しても新旧世代が混在した状態を読み手に見せない
 * (docs/sales-aggregate-snapshot-consistency-20260911.md参照)。
 */

// removeUndefinedValues: true は保険——本命の対策は buildSuccessRunStatusFields
// (lib/inventory/salesAggregateFreshness.ts)がpublishedGenerationキー自体を
// 省略すること。ここでの設定は「将来別の呼び出しがundefinedを持つフィールドを
// 混ぜてしまっても、marshallエラーでSUCCESS書き込み自体が失敗する」事故を
// 二重に防ぐためのdefense-in-depth(2026-09-11 審査対応)。
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

const INVENTORY_TABLE = process.env.INVENTORY_TABLE_NAME!;
const SNAPSHOT_TABLE = process.env.SALES_AGGREGATE_SNAPSHOT_TABLE_NAME!;
const RUN_STATUS_TABLE = process.env.SALES_AGGREGATE_RUN_STATUS_TABLE_NAME!;
const ZAICO_JOB_TABLE = process.env.ZAICO_SYNC_JOB_TABLE_NAME;

/** Queue one delta run after the sales refresh; the existing five-minute worker executes it. */
export async function queueZaicoDelta(client: Pick<typeof ddb, "send"> = ddb, tableName = ZAICO_JOB_TABLE): Promise<string> {
  if (!tableName) return "not-configured";
  if (process.env.ZAICO_TRANSITION_TABLE_NAME) {
    const transition = await client.send(new GetCommand({TableName:process.env.ZAICO_TRANSITION_TABLE_NAME,Key:{id:"transition#control"},ConsistentRead:true}));
    if (transition.Item && transition.Item.phase !== "DISABLED") return "transition-managed";
  }
  const previous = await client.send(new GetCommand({ TableName: tableName, Key: { id: ZAICO_SYNC_JOB_ID } }));
  const plan = planScheduledZaicoDelta(previous.Item ?? null);
  if (!plan) return "no-trusted-completed-baseline";
  const now = new Date().toISOString();
  try {
    await client.send(new UpdateCommand({
      TableName: tableName,
      Key: { id: ZAICO_SYNC_JOB_ID },
      ConditionExpression: "#status = :completed AND lastSuccessfulSyncAt = :baseline AND attribute_not_exists(leaseOwner)",
      UpdateExpression: "SET #status = :pending, #mode = :delta, syncSince = :since, startedAt = :now, updatedAt = :now, finishedAt = :nil, lastError = :nil, triggeredBy = :source, lastPage = :zero, totalProcessed = :zero, created = :zero, updated = :zero, unchanged = :zero, failed = :zero, imageImported = :zero, skippedByDelta = :zero, retryCount = :zero, seenSourceIds = :seen, missingSourceIds = :missing",
      ExpressionAttributeNames: { "#status": "status", "#mode": "mode" },
      ExpressionAttributeValues: {
        ":completed": "COMPLETED", ":baseline": previous.Item!.lastSuccessfulSyncAt,
        ":pending": "PENDING", ":delta": "DELTA", ":since": plan.syncSince,
        ":now": now, ":nil": null, ":source": "sales-aggregate-scheduler",
        ":zero": 0, ":seen": "[]", ":missing": [],
      },
    }));
    return "queued";
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) return "already-started";
    throw error;
  }
}

interface InvRow extends AnalysisSource {
  sourceInventoryId?:string|null;
  id: string;
  sku: string;
  name: string;
  saleEndDate?: string | null;
  salePrice?: number | null;
  purchasePrice?: number | null;
  shippingCost?: number | null;
  deletedAt?: string | null;
}

async function scanInventory(): Promise<InvRow[]> {
  const out: InvRow[] = [];
  let key: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(
      new ScanCommand({
        TableName: INVENTORY_TABLE,
        ProjectionExpression: ANALYSIS_INVENTORY_PROJECTION,
        ExpressionAttributeNames: { "#n": "name" },
        ExclusiveStartKey: key,
      }),
    );
    out.push(...((res.Items ?? []) as InvRow[]));
    key = res.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (key);
  return out;
}

interface RunStatusFields {
  state: SalesAggregateRunState;
  startedAt?: string;
  completedAt?: string | null;
  lastSuccessAt?: string | null;
  publishedGeneration?: string | null;
  monthsInSnapshot?: number | null;
  sourceRecordCount?: number | null;
  errorMessage?: string | null;
  durationMs?: number | null;
}

/**
 * SalesAggregateRunStatus(1行のみ)を更新する。既存行をGetItemで読んで
 * から渡された差分だけ上書きする —— "RUNNING"へ遷移するときに
 * lastSuccessAt等の直近の実績を消さないため。
 */
async function writeRunStatus(fields: RunStatusFields): Promise<void> {
  const now = new Date().toISOString();
  const existing = await ddb
    .send(new GetCommand({ TableName: RUN_STATUS_TABLE, Key: { id: SALES_AGGREGATE_RUN_STATUS_ID } }))
    .then((r) => r.Item as (RunStatusFields & { createdAt?: string }) | undefined);

  await ddb.send(
    new PutCommand({
      TableName: RUN_STATUS_TABLE,
      Item: {
        id: SALES_AGGREGATE_RUN_STATUS_ID,
        __typename: "SalesAggregateRunStatus",
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        startedAt: existing?.startedAt ?? now,
        completedAt: existing?.completedAt ?? null,
        lastSuccessAt: existing?.lastSuccessAt ?? null,
        publishedGeneration: existing?.publishedGeneration ?? null,
        monthsInSnapshot: existing?.monthsInSnapshot ?? null,
        sourceRecordCount: existing?.sourceRecordCount ?? null,
        errorMessage: existing?.errorMessage ?? null,
        durationMs: existing?.durationMs ?? null,
        ...fields,
      },
    }),
  );
}

export const handler = async () => {
  const startedAt = new Date().toISOString();
  // 世代IDは「この実行の開始時刻」— ISO文字列は辞書順=時系列順になる
  // ので、後段のConditionExpressionが追加の読み取り無しで
  // 「今publishされている世代より新しいか」を比較できる。
  const generation = startedAt;
  const t0 = Date.now();

  if (!INVENTORY_TABLE || !SNAPSHOT_TABLE || !RUN_STATUS_TABLE) {
    // 設定漏れを「0件で成功」にしない。
    throw new Error(
      "テーブル名が設定されていません(INVENTORY_TABLE_NAME / SALES_AGGREGATE_SNAPSHOT_TABLE_NAME / SALES_AGGREGATE_RUN_STATUS_TABLE_NAME)。",
    );
  }

  await writeRunStatus({ state: "RUNNING", startedAt, completedAt: null, errorMessage: null });

  try {
    const rows = (await scanInventory()).filter((r) => !r.deletedAt);
    if (!process.env.CATEGORY_TABLE_NAME) throw new Error('Category table is not configured');
    const categories: {id:string;name:string}[] = [];
    let categoryKey: Record<string,unknown> | undefined;
    do {
      const page = await ddb.send(new ScanCommand({TableName:process.env.CATEGORY_TABLE_NAME,ProjectionExpression:'id, #n',ExpressionAttributeNames:{'#n':'name'},ExclusiveStartKey:categoryKey}));
      categories.push(...(page.Items??[]) as {id:string;name:string}[]);
      categoryKey=page.LastEvaluatedKey;
    } while(categoryKey);
    const metadataTable = process.env.INVENTORY_ANALYSIS_METADATA_TABLE_NAME;
    if (!metadataTable) throw new Error('Inventory analysis metadata table is not configured');
    const metadata = await createAnalysisMetadataStore(ddb, metadataTable).forRebuild();
    const analysis = buildAnalysis(rows, categories, metadata.rows, startedAt, generation);
    analysis.metadata.metadataEpoch = metadata.epoch;
    const records = normalizedCapturedSalesRecords(rows, startedAt);

    const recomputed = buildMonthlyAggregates(records);

    const published = await publishAnalysis(ddb, SNAPSHOT_TABLE, analysis, recomputed, 'sales-aggregate-scheduler');
    await cleanAnalysisRetention(ddb, SNAPSHOT_TABLE).catch(error => {
      console.error('[sales-aggregate-scheduler] analysis retention cleanup failed', error instanceof Error ? error.name : 'unknown');
    });

    const completedAt = new Date().toISOString();
    // A month-end failure must not replace a valid current total or fabricate a past zero balance.
    const inventoryMonth = await ensureInventoryMonth(ddb,lastClosedInventoryMonth(),new Map(rows.filter(r=>r.sourceInventoryId).map(r=>[r.sourceInventoryId!,{id:r.id,sku:r.sku}]))).catch(error=>{
      console.error('[inventory-month] month-end restore failed',error instanceof Error?error.message:'unknown');return 'failed';
    });
    // フィールド組み立ては純粋関数(lib/inventory/salesAggregateFreshness.ts の
    // buildSuccessRunStatusFields)に委ね、publishedGenerationキーの省略
    // (undefined値を持たせない)をverify-sales-aggregate-snapshot.tsの単体
    // テストで直接検証できるようにしている(2026-09-11 審査対応)。
    await writeRunStatus(
      buildSuccessRunStatusFields({
        completedAt,
        generation,
        published,
        monthsInSnapshot: recomputed.length,
        sourceRecordCount: records.length,
        durationMs: Date.now() - t0,
      }),
    );

    console.log(
      `[sales-aggregate-scheduler] ✓ ${published ? "公開" : "より新しい世代が既にあるため公開スキップ"} / ${recomputed.length}ヶ月 / 在庫${records.length}件 / ${Date.now() - t0}ms`,
    );
    const zaicoDelta = await queueZaicoDelta().catch((error) => {
      console.error("[sales-aggregate-scheduler] ZAICO差分同期の予約に失敗。次回の定期実行で再試行します", error);
      return "queue-failed";
    });
    return { ok: true, published, monthsInSnapshot: recomputed.length, sourceRecordCount: records.length, zaicoDelta,inventoryMonth };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[sales-aggregate-scheduler] 失敗", message);
    // 失敗しても、公開ポインタ(=このスナップショット自体)は一切
    // 変更されていない——前回公開された世代がそのまま完全な形で残る
    // (欠落も二重計上も起きない、resource.tsコメント参照)。
    await writeRunStatus({
      state: "FAILED",
      completedAt: new Date().toISOString(),
      errorMessage: message,
      durationMs: Date.now() - t0,
    }).catch((statusErr) => {
      console.error("[sales-aggregate-scheduler] 実行状態の記録にも失敗", statusErr);
    });
    throw err;
  }
};

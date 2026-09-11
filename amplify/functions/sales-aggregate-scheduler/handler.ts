import { ConditionalCheckFailedException, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { buildMonthlyAggregates } from "@/lib/inventory/salesAggregate";
import type { SalesSourceRecord } from "@/lib/inventory/sales";
import { serializeSnapshotMonths, SALES_AGGREGATE_SNAPSHOT_ID } from "@/lib/inventory/salesAggregateSnapshot";
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

async function scanInventory(): Promise<InvRow[]> {
  const out: InvRow[] = [];
  let key: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(
      new ScanCommand({
        TableName: INVENTORY_TABLE,
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

    // 全月ぶんを1アイテムへ、1回のPutItemで書く。DynamoDBの単一アイテム
    // 書き込みはall-or-nothingなので、「一部の月だけ新しい世代」という
    // 状態はここで構造的に発生し得ない——このPutItemが成功した瞬間、
    // 読み手は必ず「全月が同じ世代」のスナップショットだけを見る。
    //
    // ConditionExpression: 既存アイテムが無い(初回)か、既存の世代が
    // 今回の世代より古い場合のみ書き込む。同時に2つの実行が走り、開始が
    // 遅い方(=世代が新しい方)が先に完了してpublishした後、開始が早い
    // 方(=世代が古い方、既に古いデータを計算済み)が後から完了しても、
    // このConditionExpressionが拒否するので古いデータが新しいものを
    // 上書きしない。
    let published = true;
    try {
      await ddb.send(
        new PutCommand({
          TableName: SNAPSHOT_TABLE,
          Item: {
            id: SALES_AGGREGATE_SNAPSHOT_ID,
            __typename: "SalesAggregateSnapshot",
            generation,
            monthsJson: serializeSnapshotMonths(recomputed),
            sourceRecordCount: records.length,
            rebuiltAt: generation,
            rebuiltBy: "sales-aggregate-scheduler",
            createdAt: generation,
            updatedAt: generation,
          },
          ConditionExpression: "attribute_not_exists(id) OR generation < :new",
          ExpressionAttributeValues: { ":new": generation },
        }),
      );
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) {
        // 自分より新しい世代が既に公開済み(同時実行で自分が負けた)。
        // 自分のデータが誤っているわけではないので失敗として扱わない
        // ——現在公開されているのは、より新しい正しいスナップショット。
        published = false;
      } else {
        throw err;
      }
    }

    const completedAt = new Date().toISOString();
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
    return { ok: true, published, monthsInSnapshot: recomputed.length, sourceRecordCount: records.length };
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

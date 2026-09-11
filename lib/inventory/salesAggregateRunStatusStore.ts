import "server-only";
import { inventoryAuthMode, serverDataClient } from "@/lib/amplify/dataClient";
import { SALES_AGGREGATE_RUN_STATUS_ID, type SalesAggregateRunStatusRow } from "./salesAggregateFreshness";

/**
 * 売上集計の定期実行状態の読み取り(SSR側)。
 *
 * 書き込みは amplify/functions/sales-aggregate-scheduler/handler.ts が
 * IAM(生DynamoDB API)から直接行う——このファイルは書き込みを持たない
 * (SSR/ブラウザ経路からこの状態を書き換える正当な理由が無いため)。
 *
 * GetItem 1回。主キー固定("current")なので Scan にはならない。
 */
export async function getSalesAggregateRunStatus(): Promise<SalesAggregateRunStatusRow | null> {
  const { data } = await serverDataClient.models.SalesAggregateRunStatus.get(
    { id: SALES_AGGREGATE_RUN_STATUS_ID },
    inventoryAuthMode,
  );
  if (!data) return null;
  return {
    id: data.id,
    state: data.state as SalesAggregateRunStatusRow["state"],
    startedAt: data.startedAt,
    completedAt: data.completedAt ?? null,
    lastSuccessAt: data.lastSuccessAt ?? null,
    publishedGeneration: data.publishedGeneration ?? null,
    monthsInSnapshot: data.monthsInSnapshot ?? null,
    sourceRecordCount: data.sourceRecordCount ?? null,
    errorMessage: data.errorMessage ?? null,
    durationMs: data.durationMs ?? null,
  };
}

import "server-only";
import { inventoryAuthMode, serverDataClient } from "@/lib/amplify/dataClient";
import { listAllPages } from "@/lib/amplify/listAll";
import type { SalesMonthlyAggregateRow } from "./salesAggregate";

/**
 * 売上月次集計の読み書き。
 *
 * 読み出しは「月を指定した GetItem」か「全件」の2通りだけ。
 * identifier が yearMonth なので、月指定は Scan にならない。
 */

type Row = {
  yearMonth: string;
  count: number;
  totalSales: number;
  totalPurchase: number;
  totalShipping: number;
  totalCost: number;
  totalProfit: number;
  sourceRecordCount?: number | null;
  rebuiltAt: string;
  rebuiltBy?: string | null;
};

export interface StoredAggregate extends SalesMonthlyAggregateRow {
  sourceRecordCount: number | null;
  rebuiltAt: string;
  rebuiltBy: string | null;
}

function toStored(row: Row): StoredAggregate {
  return {
    yearMonth: row.yearMonth,
    count: row.count,
    totalSales: row.totalSales,
    totalPurchase: row.totalPurchase,
    totalShipping: row.totalShipping,
    totalCost: row.totalCost,
    totalProfit: row.totalProfit,
    sourceRecordCount: row.sourceRecordCount ?? null,
    rebuiltAt: row.rebuiltAt,
    rebuiltBy: row.rebuiltBy ?? null,
  };
}

/** 1ヶ月ぶん。主キー指定なので1回の GetItem。 */
export async function getMonthlyAggregate(yearMonth: string): Promise<StoredAggregate | null> {
  const { data } = await serverDataClient.models.SalesMonthlyAggregate.get({ yearMonth }, inventoryAuthMode);
  return data ? toStored(data as unknown as Row) : null;
}

/**
 * 複数月ぶん(推移グラフ用)。
 *
 * 12ヶ月なら GetItem 12回。全件 Scan して 12回集計し直すのとは桁が違う。
 * 存在しない月は結果に含まれない(呼び出し側が0として扱う)。
 */
export async function getMonthlyAggregates(yearMonths: string[]): Promise<Map<string, StoredAggregate>> {
  const rows = await Promise.all(yearMonths.map((ym) => getMonthlyAggregate(ym)));
  const map = new Map<string, StoredAggregate>();
  for (const r of rows) if (r) map.set(r.yearMonth, r);
  return map;
}

/** 保存済みの全件(drift検査・再構築で使う)。 */
export async function listAllMonthlyAggregates(): Promise<StoredAggregate[]> {
  const rows = await listAllPages<Row>(
    async (nextToken) => {
      const res = await serverDataClient.models.SalesMonthlyAggregate.list({ limit: 500, nextToken, ...inventoryAuthMode });
      return { data: res.data as unknown as Row[], nextToken: res.nextToken, errors: res.errors };
    },
    { label: "売上月次集計" },
  );
  return rows.map(toStored).sort((a, b) => (a.yearMonth < b.yearMonth ? -1 : 1));
}

/**
 * 集計を書き込む(upsert)。
 *
 * 「作り直し」が唯一の更新手段なので、加算はしない。同じ入力なら何度
 * 実行しても同じ結果になる。
 */
export async function putMonthlyAggregate(
  row: SalesMonthlyAggregateRow,
  meta: { sourceRecordCount: number; rebuiltBy: string | null },
): Promise<void> {
  const fields = {
    yearMonth: row.yearMonth,
    count: row.count,
    totalSales: row.totalSales,
    totalPurchase: row.totalPurchase,
    totalShipping: row.totalShipping,
    totalCost: row.totalCost,
    totalProfit: row.totalProfit,
    sourceRecordCount: meta.sourceRecordCount,
    rebuiltAt: new Date().toISOString(),
    rebuiltBy: meta.rebuiltBy ?? undefined,
  };
  const { data: existing } = await serverDataClient.models.SalesMonthlyAggregate.get(
    { yearMonth: row.yearMonth },
    inventoryAuthMode,
  );
  const { errors } = existing
    ? await serverDataClient.models.SalesMonthlyAggregate.update(fields, inventoryAuthMode)
    : await serverDataClient.models.SalesMonthlyAggregate.create(fields, inventoryAuthMode);
  if (errors) throw new Error(`売上集計の保存に失敗しました(${row.yearMonth}): ${JSON.stringify(errors)}`);
}

/**
 * 集計に残っているが、いま作り直したら存在しない月を消す。
 *
 * 全件取消などで月ごとまるごと売上が無くなった場合、消さないと
 * 古い数字が残り続ける。
 */
export async function deleteMonthlyAggregate(yearMonth: string): Promise<void> {
  const { errors } = await serverDataClient.models.SalesMonthlyAggregate.delete({ yearMonth }, inventoryAuthMode);
  if (errors) throw new Error(`売上集計の削除に失敗しました(${yearMonth}): ${JSON.stringify(errors)}`);
}

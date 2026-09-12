/**
 * scripts/verify-sales-view-trend-scan.ts 専用fixture。
 *
 * lib/inventory/salesView.ts が呼ぶ lib/inventory/salesAggregateStore.ts の
 * getMonthlyAggregatesだけを差し替える。本物と同じく「存在しない月は
 * 結果のMapに含めない」(呼び出し側が0扱いする)仕様を再現する。
 */

let aggregates = new Map();
let failAllMessage = null; // string | null

/** その回で「集計テーブルにある」ことにする月だけを登録する。 */
export function __setAggregates(map) {
  aggregates = map;
  failAllMessage = null;
}

/** 以後の呼び出しをすべて失敗させる(集計テーブル自体が読めないケース)。 */
export function __failAll(message) {
  failAllMessage = message;
}

export async function getMonthlyAggregates(yearMonths) {
  if (failAllMessage) {
    throw new Error(failAllMessage);
  }
  const result = new Map();
  for (const ym of yearMonths) {
    if (aggregates.has(ym)) result.set(ym, aggregates.get(ym));
  }
  return result;
}

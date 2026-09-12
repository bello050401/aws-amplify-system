/**
 * scripts/verify-sales-view-trend-scan.ts 専用fixture。
 *
 * lib/inventory/salesView.ts が実際に呼ぶ lib/inventory/queries.ts の2関数
 * (listAllInventory / listInventoryBySaleMonth)だけを、AWS呼び出し無しの
 * in-memoryスタブとして再現する。呼び出し回数・引数を記録するのは、検証が
 * 「返り値が正しいか」だけでなく「Scanが何回走ったか」(このスクリプトが
 * 確かめたい速度上の性質)も確認する必要があるため。
 *
 * 本物のqueries.tsとの対応:
 *   listAllInventory()                … 在庫全件Scan相当
 *   listInventoryBySaleMonth(year, month) … saleEndDateの前方一致でその
 *     月ぶんだけ絞ったScan相当(実物のprefixロジックと同じ判定をここでも
 *     行う — モック側だけ別の基準で「その月」を判定すると、本物では起き
 *     ない食い違いをテストが検出できなくなる)。
 */

let records = [];
let failNext = null; // { fn: string, message: string } | null

export const calls = {
  listAllInventory: 0,
  listInventoryBySaleMonth: [],
};

/** シナリオごとに呼び出し記録とfixtureを初期化する。 */
export function __reset(fixtureRecords) {
  records = fixtureRecords;
  failNext = null;
  calls.listAllInventory = 0;
  calls.listInventoryBySaleMonth = [];
}

/** 次にfnが呼ばれたときだけ例外を投げる(1回限り)。 */
export function __failNext(fn, message) {
  failNext = { fn, message };
}

function maybeThrow(fn) {
  if (failNext && failNext.fn === fn) {
    const message = failNext.message;
    failNext = null;
    throw new Error(message);
  }
}

export async function listAllInventory() {
  calls.listAllInventory += 1;
  maybeThrow("listAllInventory");
  return records;
}

export async function listInventoryBySaleMonth(year, month) {
  calls.listInventoryBySaleMonth.push(`${year}-${month}`);
  maybeThrow("listInventoryBySaleMonth");
  // 本物(lib/inventory/queries.ts)と同じ前方一致判定。
  const prefix = `${year}-${String(month).padStart(2, "0")}-`;
  return records.filter((r) => typeof r.saleEndDate === "string" && r.saleEndDate.startsWith(prefix));
}

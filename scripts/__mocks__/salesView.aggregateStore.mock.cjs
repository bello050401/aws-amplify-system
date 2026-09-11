/**
 * scripts/verify-sales-view-trend-scan.ts 専用fixture。
 *
 * lib/inventory/salesView.ts が呼ぶ lib/inventory/salesAggregateStore.ts の
 * getMonthlyAggregatesだけを差し替える。本物と同じく、
 *   - 取得できた月だけを aggregates に含める(無い月は含めない=missing)
 *   - GetItem自体が例外を投げた場合はfailedMonthsに要求された月全部を
 *     積む(=error。2026-09-11世代整合性修正で読み取りが単一
 *     アイテムになったため、「一部の月だけ失敗」は表現しない——実物の
 *     salesAggregateStore.tsも同じ挙動)
 * という{aggregates, failedMonths}の形を再現する。
 *
 * .mjs ではなく .cjs にしているのは意図的(2026-09-11 task_e509 引継ぎ
 * 完了対応): lib/inventory/salesView.ts(トップレベルawaitを持たない.ts)
 * はpackage.jsonに"type":"module"が無いためtsxによってCJS出力に変換
 * される。CJS化されたモジュールからこの fixture を .mjs(=常にESM)
 * としてrequireすると、Nodeのrequire(esm)相互運用が"await import()"で
 * 直接読み込んだ別インスタンスとは別のモジュールレコードを作ってしまい、
 * テスト側の__setAggregates()が実際にsalesView.tsが参照するインスタンス
 * へ反映されない(状態が分裂する)。.cjs であれば require() 経由でも
 * import() 経由でも同じ Module._cache を共有するため、この分裂が
 * 起きない。
 */

let aggregates = new Map();
let failAllMessage = null; // string | null — getMonthlyAggregates自体が丸ごと失敗するケース(GetItem失敗・monthsJson破損等)を模す

/** その回で「集計テーブルにある」ことにする月だけを登録する。 */
function __setAggregates(map) {
  aggregates = map;
  failAllMessage = null;
}

/** 呼び出し自体を丸ごと失敗させる(単一スナップショットのGetItemが例外を投げるケース)。 */
function __failAll(message) {
  failAllMessage = message;
}

async function getMonthlyAggregates(yearMonths) {
  if (failAllMessage) {
    return { aggregates: new Map(), failedMonths: [...yearMonths] };
  }
  const result = new Map();
  for (const ym of yearMonths) {
    if (aggregates.has(ym)) result.set(ym, aggregates.get(ym));
  }
  return { aggregates: result, failedMonths: [] };
}

module.exports = { __setAggregates, __failAll, getMonthlyAggregates };

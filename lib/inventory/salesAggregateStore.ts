import "server-only";
import { inventoryAuthMode, serverDataClient } from "@/lib/amplify/dataClient";
import { deserializeSnapshotMonths, monthsToMap, SALES_AGGREGATE_SNAPSHOT_ID } from "./salesAggregateSnapshot";
import type { SalesMonthlyAggregateRow } from "./salesAggregate";

/**
 * 売上月次集計の読み取り(2026-09-11 世代整合性修正、2026-09-11
 * task_e509 引継ぎ完了対応)。
 *
 * 書き込みはこのファイルの責務ではない——amplify/functions/
 * sales-aggregate-scheduler/handler.ts(定期実行、IAM生DynamoDB API)と
 * scripts/rebuild-sales-aggregate.ts(手動再構築)が、どちらも同じ
 * lib/inventory/salesAggregateSnapshot.ts のロジックに沿って
 * SalesAggregateSnapshot(id="current"固定の1行)へ直接書く
 * (SalesAggregateRunStatusと同じ「SSR側は読み取り専用」の境界)。
 *
 * 読み出しは常に GetItem 1回("current"固定)——何ヶ月要求しても、月数分
 * GetItemを繰り返していた旧設計(SalesMonthlyAggregate、月ごとに1行)
 * より読み取りコストが低く、かつ返る値は必ず同じ1回の読み取り
 * (=同じ世代)からのものになる。
 *
 * ── 2026-09-11 task_e509 引継ぎ完了対応: 2つの修正 ─────────────────
 *
 * 1. GraphQL errors を無視しない。`serverDataClient...get()` は
 *    `{ data, errors }` を返すが、`data` だけを見て `errors` を無視する
 *    と、権限不足・一時障害等で `data` が null になったケースが「行が
 *    まだ無い(neverRun)」と区別できなくなる——実障害が「未集計」という
 *    正常状態に化けてしまう。ここでは `errors` を明示的に見て、あれば
 *    例外を投げる(呼び出し側の getMonthlyAggregates が catch し、
 *    要求された月すべてを failedMonths に積む=error 扱いにする)。
 * 2. 「スナップショットが存在するが指定月が無い」と「スナップショット
 *    自体が存在しない」を区別する。前者は「集計した結果、その月の対象
 *    売上が0件だった」ことが確定している(定期実行は毎回、在庫全件から
 *    全月を作り直すため——lib/inventory/salesAggregate.tsの
 *    buildMonthlyAggregates参照)ので、0埋めの行を作って返す(status=ok、
 *    値0)。後者(スナップショット自体が無い)だけが真の「未集計」
 *    (missing)になる。
 */

export interface StoredAggregate extends SalesMonthlyAggregateRow {
  sourceRecordCount: number | null;
  rebuiltAt: string;
  rebuiltBy: string | null;
  /** どの世代(定期実行の開始時刻)から得られた値か。 */
  generation: string;
}

interface SnapshotData {
  generation: string;
  rebuiltAt: string;
  rebuiltBy: string | null;
  sourceRecordCount: number;
  months: SalesMonthlyAggregateRow[];
}

/**
 * SalesAggregateSnapshot を1回のGetItemで読む。モジュールレベルの
 * キャッシュは持たない——SSRの1リクエスト内で複数回呼ばれても
 * (getMonthlyAggregate→getMonthlyAggregatesの内部呼び出し程度)実害の
 * 無い回数であり、リクエストをまたいで古い値を握り続ける事故の方が害が
 * 大きい。
 */
async function fetchSnapshot(): Promise<SnapshotData | null> {
  const { data, errors } = await serverDataClient.models.SalesAggregateSnapshot.get(
    { id: SALES_AGGREGATE_SNAPSHOT_ID },
    inventoryAuthMode,
  );
  // errorsを無視して「data無し」と一律neverRun扱いにしない——権限不足・
  // 一時障害等の実障害と「まだ一度もPutItemされていない」を区別する。
  if (errors) {
    throw new Error(`SalesAggregateSnapshotの取得に失敗しました: ${JSON.stringify(errors)}`);
  }
  if (!data) return null;
  return {
    generation: data.generation,
    rebuiltAt: data.rebuiltAt,
    rebuiltBy: data.rebuiltBy ?? null,
    sourceRecordCount: data.sourceRecordCount,
    months: deserializeSnapshotMonths(data.monthsJson),
  };
}

function toStored(row: SalesMonthlyAggregateRow, snapshot: SnapshotData): StoredAggregate {
  return {
    ...row,
    sourceRecordCount: snapshot.sourceRecordCount,
    rebuiltAt: snapshot.rebuiltAt,
    rebuiltBy: snapshot.rebuiltBy,
    generation: snapshot.generation,
  };
}

/** スナップショットは存在するが対象月の行が無い場合の「実0件」の行。 */
function zeroRow(yearMonth: string): SalesMonthlyAggregateRow {
  return { yearMonth, count: 0, totalSales: 0, totalPurchase: 0, totalShipping: 0, totalCost: 0, totalProfit: 0 };
}

/** 1ヶ月ぶん。内部的には getMonthlyAggregates と同じ1回のGetItem。 */
export async function getMonthlyAggregate(yearMonth: string): Promise<StoredAggregate | null> {
  const { aggregates } = await getMonthlyAggregates([yearMonth]);
  return aggregates.get(yearMonth) ?? null;
}

export interface MonthlyAggregatesResult {
  aggregates: Map<string, StoredAggregate>;
  failedMonths: string[];
}

/**
 * 複数月ぶん(推移グラフ用)。GetItem 1回("current"固定)のみ。
 *
 * ・スナップショット自体が存在しない(neverRun) → 要求した月は全て結果
 *   に含めない(=missing、呼び出し側が「未集計」として扱う)。
 * ・スナップショットは存在するが、要求した月の行が無い → 「集計した
 *   結果、その月の対象売上が0件だった」ことが確定しているので、0埋めの
 *   行を結果に含める(=ok、値は0——「未集計」と「実0件」の区別が
 *   ここで初めて生まれる)。
 * ・GetItem自体が例外を投げた場合(未デプロイ・スロットリング・
 *   monthsJsonの破損・GraphQL errors等)は、要求された月**全部**を
 *   failedMonths として返す——読み取りが単一アイテムになった以上、
 *   「一部の月だけ取得失敗」という状態はもう存在しない(全部成功するか
 *   全部失敗するかのどちらか)。
 *
 * 呼び出し側(lib/inventory/salesView.ts)は引き続き
 * {aggregates, failedMonths} という同じ形を受け取るため、この内部実装の
 * 変更は呼び出し側に影響しない。
 */
export async function getMonthlyAggregates(yearMonths: string[]): Promise<MonthlyAggregatesResult> {
  let snapshot: SnapshotData | null;
  try {
    snapshot = await fetchSnapshot();
  } catch (err) {
    console.warn("[sales] SalesAggregateSnapshotの取得に失敗しました(要求した月すべてをerror扱い)", {
      error: err instanceof Error ? err.message : String(err),
    });
    return { aggregates: new Map(), failedMonths: [...yearMonths] };
  }
  if (!snapshot) return { aggregates: new Map(), failedMonths: [] }; // neverRun → 全月missing(errorではない)

  const byMonth = monthsToMap(snapshot.months);
  const aggregates = new Map<string, StoredAggregate>();
  for (const ym of yearMonths) {
    // スナップショットは存在するので、行が無い月は「実0件」——欠損
    // (missing)として消さず、0埋めの確定値として含める。
    const row = byMonth.get(ym) ?? zeroRow(ym);
    aggregates.set(ym, toStored(row, snapshot));
  }
  return { aggregates, failedMonths: [] };
}

/** 保存済みスナップショットの全月(drift検査・手動再構築スクリプトのdry-run表示で使う)。 */
export async function listAllMonthlyAggregates(): Promise<StoredAggregate[]> {
  const snapshot = await fetchSnapshot();
  if (!snapshot) return [];
  return snapshot.months.map((row) => toStored(row, snapshot)).sort((a, b) => (a.yearMonth < b.yearMonth ? -1 : 1));
}

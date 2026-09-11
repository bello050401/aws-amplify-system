import type { SalesMonthlyAggregateRow } from "./salesAggregate";

/**
 * 売上月次集計の「世代スナップショット」表現(2026-09-11 世代整合性
 * 修正、2026-09-11 task_e509 引継ぎ完了対応で壊れた配列要素の検証を追加)。
 *
 * ── 何を解決したか ────────────────────────────────────────────────
 *
 * 以前の設計(task_45/task_990、docs/sales-aggregate-snapshot-
 * consistency-20260911.md に詳細)は、月(yearMonth)ごとに独立した行を
 * 持ち、定期再構築のたびに月ごとへ個別の PutItem/DeleteItem を発行して
 * いた。「1月から2月へ売上を訂正」のような複数月にまたがる訂正の反映中
 * に一部の書き込みだけが失敗すると、読み手が「1月は新世代・2月は旧
 * 世代」という**複数月を横断した合計が矛盾する**状態を読んでしまい得た
 * (1月成功・2月失敗なら該当額が欠落、逆なら二重計上)。
 *
 * ── この設計 ────────────────────────────────────────────────────
 *
 * 全月ぶんの集計を1つのDynamoDBアイテム(SalesAggregateSnapshot、
 * id="current"固定)にまとめて持つ。DynamoDBの単一アイテムへの
 * PutItemはそれ自体が原子的(all-or-nothing)——「一部の月だけ新しい」
 * という状態が構造的に発生し得ない。「世代別保存→全件成功後に公開」を
 * 実現するための専用の公開ポインタテーブルは不要で、このスナップショット
 * 自体が常にひとつの確定世代を表す。
 *
 * `generation`(定期実行の開始時刻ISO文字列)は、同時実行時に古い世代が
 * 新しい世代を上書きしないための楽観的排他制御キー(ISO文字列は辞書順
 * =時系列順になるため、DynamoDBのConditionExpressionで追加の読み取り
 * 無しに比較できる)。
 *
 * このファイルは純粋関数のみ(外部依存なし)。DBアクセスは
 * amplify/functions/sales-aggregate-scheduler/handler.ts(書き込み)/
 * lib/inventory/salesAggregateStore.ts(SSR読み取り)/
 * scripts/rebuild-sales-aggregate.ts(手動再構築)の責務。
 *
 * ── 容量(400KB単一アイテム上限)の想定 ──────────────────────────
 *
 * 母集団は在庫約5,300件(lib/inventory/salesAggregate.tsの実測コメント
 * 参照)。集計後の行数は「月の数」であり、在庫件数には依存しない——
 * 10年運用しても120行程度。1行(SalesMonthlyAggregateRow)は数値6個+
 * "YYYY-MM"の短い文字列1個で、JSON化しても1行あたり150バイト前後。
 * 120行でも18KB程度で、DynamoDBアイテムの400KB上限に対して二桁以上の
 * 余裕がある。月次集計という性質上、行の増加は在庫の増加ではなく時間の
 * 経過(月数)にしか依存しないため、将来在庫が何倍に増えてもこの見積り
 * は変わらない。
 */

/** SalesAggregateRunStatus/SalesAggregateSnapshot テーブルの唯一の行のID。 */
export const SALES_AGGREGATE_SNAPSHOT_ID = "current";

export function serializeSnapshotMonths(months: SalesMonthlyAggregateRow[]): string {
  return JSON.stringify(months);
}

const REQUIRED_NUMERIC_FIELDS: (keyof SalesMonthlyAggregateRow)[] = [
  "count",
  "totalSales",
  "totalPurchase",
  "totalShipping",
  "totalCost",
  "totalProfit",
];

/**
 * 1行が壊れていないかを検証する。手動操作ミス・部分的な書き込み障害
 * (実際には単一アイテムのPutItemなので起き得ないはずだが、将来の実装
 * 変更やDB外からの直接編集に備える防御)で生まれ得る不正値を洗い出す:
 *
 *   ・yearMonth が "YYYY-MM" 形式でない
 *   ・必須の数値フィールドが number でない、または NaN/Infinity
 *
 * 「型としてはnumberだがNaN/Infinity」はJSON.parseの結果には出ない
 * (JSONにNaN/Infinityのリテラルは存在しない)が、JSON.parseが返す
 * `unknown`をそのままキャストして使っていないことを明示するため、
 * 実行時にも機械的にチェックする——将来この関数の呼び出し元が変わり、
 * 手書きJSON等JSON.parseを経由しない入力を受けるようになっても安全。
 */
function isValidMonthRow(row: unknown): row is SalesMonthlyAggregateRow {
  if (typeof row !== "object" || row === null) return false;
  const r = row as Record<string, unknown>;
  if (typeof r.yearMonth !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(r.yearMonth)) return false;
  for (const field of REQUIRED_NUMERIC_FIELDS) {
    const v = r[field];
    if (typeof v !== "number" || !Number.isFinite(v)) return false;
  }
  return true;
}

/**
 * 保存されたJSONを月次集計の配列へ戻す。壊れたJSON(手動操作ミス等)や
 * 配列でない値、配列の要素が不正(必須項目欠落・数値が非有限・yearMonth
 * の重複)な場合は例外を投げる——「読めなかった」を黙って「集計0件
 * (=売上0円)」に見せない(§8「初回未集計と売上0を区別」と同じ考え方)。
 * 不正な要素が1つでも混ざっていれば、その要素だけを無視せず配列全体を
 * 信用しない(どの月が壊れているか分からない以上、他の月の値も同じ
 * 書き込み処理から生まれたものであり、部分的な信頼はできない)。
 * 呼び出し側(salesAggregateStore.ts)はこれを"error"として扱う。
 */
export function deserializeSnapshotMonths(json: string): SalesMonthlyAggregateRow[] {
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed)) throw new Error("SalesAggregateSnapshot.monthsJson が配列ではありません");

  const seen = new Set<string>();
  for (const row of parsed) {
    if (!isValidMonthRow(row)) {
      throw new Error("SalesAggregateSnapshot.monthsJson に不正な行が含まれています");
    }
    if (seen.has(row.yearMonth)) {
      throw new Error(`SalesAggregateSnapshot.monthsJson に yearMonth の重複があります: ${row.yearMonth}`);
    }
    seen.add(row.yearMonth);
  }
  return parsed as SalesMonthlyAggregateRow[];
}

export function monthsToMap(months: SalesMonthlyAggregateRow[]): Map<string, SalesMonthlyAggregateRow> {
  return new Map(months.map((m) => [m.yearMonth, m]));
}

/**
 * 新しい世代を公開してよいか(=既存の世代より新しいか)を判定する。
 *
 * ISO 8601の時刻文字列(常に同じ桁数・UTC)は辞書順比較がそのまま時系列
 * 順比較になる——amplify/functions/sales-aggregate-scheduler/handler.ts
 * のDynamoDB ConditionExpression("generation < :new")と全く同じ判定を
 * ここでも純粋関数として再現し、両者がずれないようにする(scripts/
 * verify-sales-aggregate-snapshot.tsがこの関数とhandler.tsの文字列条件
 * 双方の一致を検証する)。
 */
export function isNewerGeneration(existingGeneration: string | null | undefined, candidateGeneration: string): boolean {
  if (!existingGeneration) return true;
  return existingGeneration < candidateGeneration;
}

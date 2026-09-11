/**
 * 売上月次集計の定期実行(2026-09-11 世代整合性修正)の状態表現。
 *
 * 純粋関数のみ。DBアクセスは salesAggregateRunStatusStore.ts(SSR読み取り)/
 * amplify/functions/sales-aggregate-scheduler/handler.ts(書き込み)の責務。
 *
 * ── なぜ「更新間隔」をここに置くのか ─────────────────────────────
 *
 * 画面(鮮度の警告表示)とLambda(スケジュール定義のコメント)の両方が
 * 「何時間ごとの前提か」を知る必要がある。数値がずれると、実際は正常な
 * 遅延なのに画面が「遅延中」と誤表示する。値そのものは
 * amplify/functions/sales-aggregate-scheduler/resource.ts の `schedule`
 * 文字列(実際にEventBridgeへ配線される値)と人力で一致させる必要がある
 * ——ここを唯一の参照元にして、スケジュール変更時はコメントで揃える。
 */

/** 定期実行の間隔(時間)。resource.ts の schedule: "every 12h" と一致させる。 */
export const SALES_AGGREGATE_SCHEDULE_HOURS = 12;

/**
 * "RUNNING" のまま何分経過したら「止まった」とみなすか。
 *
 * Lambda自体のtimeoutSeconds(resource.ts)より短く設定する —— timeout
 * ちょうどで判定すると、Lambdaが実際にtimeoutで落ちた直後の一瞬だけ
 * 「まだ実行中」と誤表示する窓ができる。
 */
export const SALES_AGGREGATE_RUN_TIMEOUT_MINUTES = 5;

/**
 * 前回成功からこの時間を超えたら「定期実行が止まっている疑い」を出す。
 * 通常運用の12時間間隔に対し2周期ぶんの余裕を持たせ、実行が多少
 * ずれ込んだだけの正常なケースを誤検知しない。
 */
export const SALES_AGGREGATE_STALE_AFTER_HOURS = SALES_AGGREGATE_SCHEDULE_HOURS * 2;

/** SalesAggregateRunStatus テーブルの唯一の行のID。 */
export const SALES_AGGREGATE_RUN_STATUS_ID = "current";

export type SalesAggregateRunState = "RUNNING" | "SUCCESS" | "FAILED";

export interface SalesAggregateRunStatusRow {
  id: string;
  state: SalesAggregateRunState;
  startedAt: string;
  completedAt: string | null;
  lastSuccessAt: string | null;
  publishedGeneration: string | null;
  monthsInSnapshot: number | null;
  sourceRecordCount: number | null;
  errorMessage: string | null;
  durationMs: number | null;
}

export interface AggregateFreshness {
  /** 一度も定期実行されたことが無い(初回未構築)。 */
  neverRun: boolean;
  /** いま実行中と判定してよいか(state=RUNNING かつ timeout 未経過)。 */
  isRunning: boolean;
  /** RUNNING のまま timeout を超えている(実行が止まった疑い)。 */
  isStalled: boolean;
  /** 直近の試行が失敗している(表示中の数値は前回成功時点のまま)。 */
  lastAttemptFailed: boolean;
  /** 前回成功(またはゼロ回)から SALES_AGGREGATE_STALE_AFTER_HOURS 以上経過。 */
  isStale: boolean;
  lastSuccessAt: string | null;
  errorMessage: string | null;
}

/**
 * 実行状態の行から、画面が使う判定を導く。
 *
 * `row` が null なのは「まだ一度もこのLambdaが完了報告を書いたことが
 * 無い」場合(初回デプロイ直後 等)。この場合も**例外にせず**、
 * neverRun=true という正常な状態として返す。
 */
export function describeAggregateFreshness(row: SalesAggregateRunStatusRow | null, nowIso: string): AggregateFreshness {
  if (!row) {
    return {
      neverRun: true,
      isRunning: false,
      isStalled: false,
      lastAttemptFailed: false,
      isStale: true,
      lastSuccessAt: null,
      errorMessage: null,
    };
  }

  const now = new Date(nowIso).getTime();
  const startedAtMs = new Date(row.startedAt).getTime();
  const runningElapsedMs = now - startedAtMs;
  const timeoutMs = SALES_AGGREGATE_RUN_TIMEOUT_MINUTES * 60_000;

  const isRunning = row.state === "RUNNING" && runningElapsedMs <= timeoutMs;
  const isStalled = row.state === "RUNNING" && runningElapsedMs > timeoutMs;
  const lastAttemptFailed = row.state === "FAILED";

  const isStale = row.lastSuccessAt
    ? now - new Date(row.lastSuccessAt).getTime() > SALES_AGGREGATE_STALE_AFTER_HOURS * 3_600_000
    : true; // 一度も成功していないなら常に「古い(要注意)」扱い

  return {
    neverRun: false,
    isRunning,
    isStalled,
    lastAttemptFailed,
    isStale,
    lastSuccessAt: row.lastSuccessAt,
    errorMessage: row.errorMessage,
  };
}

export interface SuccessRunStatusInput {
  completedAt: string;
  generation: string;
  /** 自分の世代を公開できたか(同時実行で自分より新しい世代に負けていない)。 */
  published: boolean;
  monthsInSnapshot: number;
  sourceRecordCount: number;
  durationMs: number;
}

export interface SuccessRunStatusFields {
  state: "SUCCESS";
  completedAt: string;
  lastSuccessAt: string;
  publishedGeneration?: string;
  monthsInSnapshot: number;
  sourceRecordCount: number;
  errorMessage: null;
  durationMs: number;
}

/**
 * SUCCESS書き込み時のフィールド集合を組み立てる純粋関数。
 *
 * `published=false`(同時実行で自分より新しい世代が既に公開されていた側)
 * のときは `publishedGeneration` を**キーごと省略する**——`undefined`を
 * 値として持たせると、DynamoDBDocumentClient のデフォルト設定
 * (`marshallOptions.removeUndefinedValues` 未指定=false)はそのオブジェクトを
 * marshallできずエラーを投げる。つまり「負けた側」がSUCCESS状態(=自分は
 * 正しく計算できた、公開だけスキップした)を記録できずFAILED扱いになる
 * という別の不整合を生んでいた(2026-09-11 審査で指摘、handler.ts参照)。
 * 呼び出し側(amplify/functions/sales-aggregate-scheduler/handler.ts)は
 * この関数が返したオブジェクトをそのまま PutCommand の Item にスプレッドする。
 */
export function buildSuccessRunStatusFields(input: SuccessRunStatusInput): SuccessRunStatusFields {
  const { completedAt, generation, published, monthsInSnapshot, sourceRecordCount, durationMs } = input;
  return {
    state: "SUCCESS",
    completedAt,
    lastSuccessAt: completedAt,
    ...(published ? { publishedGeneration: generation } : {}),
    monthsInSnapshot,
    sourceRecordCount,
    errorMessage: null,
    durationMs,
  };
}

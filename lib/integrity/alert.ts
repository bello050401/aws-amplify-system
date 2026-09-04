/**
 * 整合性監視の「通知に出す形」（2026-09-04 最終クローズ Phase B）。
 *
 * **純粋関数だけ。** AWSにもログにも触らない —— 通知の中身と、アラームを
 * 動かすメトリクスの値を、実行しなくても検査できるようにするため。
 *
 * ここが崩れると、
 *   ・正常なのに毎日通知が飛ぶ（すぐ誰も読まなくなる）
 *   ・異常なのに何も飛ばない（気づけない）
 * のどちらかになる。どちらも「監視がある」という前提を静かに壊す。
 */
import type { IntegrityRunResult } from "./compare";

/** CloudWatch のメトリクス名（amplify/backend.ts のアラームと一致させる）。 */
export const ALERT_METRIC_NAMESPACE = "BELLO/Integrity";
export const ALERT_METRIC_NAME = "IntegrityAlert";
/** ログの1行目。メトリクスとは別に、人がログを読むときの目印。 */
export const ALERT_LOG_PREFIX = "[integrity-monitor] ALERT";

/**
 * アラーム用のメトリクス行（EMF: Embedded Metric Format）。
 *
 * 決まった形のJSONをログへ出すだけでCloudWatchがメトリクス化する。
 * `AWS::Logs::MetricFilter` を使わないのは、その作成にロググループの実在が
 * 要り、まだ一度も走っていないアプリでデプロイが落ちるため
 * （amplify/backend.ts の該当コメント参照）。
 *
 * **正常時も 0 を出す。** 出さないとデータ欠損になり、異常のあとアラームが
 * ALARM のまま張り付いて次の異常に気づけなくなる。
 */
export function buildAlertMetricLine(result: IntegrityRunResult, timestampMs: number): string {
  return JSON.stringify({
    _aws: {
      Timestamp: timestampMs,
      CloudWatchMetrics: [
        {
          Namespace: ALERT_METRIC_NAMESPACE,
          Dimensions: [[]],
          Metrics: [{ Name: ALERT_METRIC_NAME, Unit: "Count" }],
        },
      ],
    },
    [ALERT_METRIC_NAME]: result.shouldNotify ? 1 : 0,
    overall: result.overall,
  });
}

/**
 * 異常時のログ本文。
 *
 * 入れるもの（指示書§13）: 発生日時 / 判定 / 異常項目 / 基準値 / 現在値 /
 * 差分 / 実行を辿るための情報。
 *
 * **正常な項目は入れない。** 20項目のうち19が正常な日に全部並べると、
 * 本当に見るべき1行が埋もれる。
 */
export function buildAlertLog(params: {
  result: IntegrityRunResult;
  requestId: string | null;
  historyTable: string;
}): string {
  const { result, requestId, historyTable } = params;
  return [
    `${ALERT_LOG_PREFIX} ${result.overall}`,
    "BELLO Data Integrity Alert",
    `発生日時: ${result.runAt}`,
    `判定: ${result.overall}`,
    `実行ID: ${requestId ?? "(不明)"}`,
    `履歴: ${historyTable} / id=run#${result.runAt}`,
    "",
    result.notificationText ?? "",
  ].join("\n");
}

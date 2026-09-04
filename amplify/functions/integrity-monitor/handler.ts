import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { collectIntegrityMetrics } from "../../../lib/integrity/collect";
import { compareIntegrity, formatRunResult, toHistoryEntry } from "../../../lib/integrity/compare";
import { appendHistory, loadBaseline, saveBaseline } from "../../../lib/integrity/store";
import { INTEGRITY_TABLE_ENV } from "../../../lib/integrity/tables";

/**
 * データ整合性の日次監視（resource.ts のファイル冒頭コメント参照）。
 *
 * **読むだけ。** 監視ログのテーブル以外へは1バイトも書かない。
 * 異常を見つけても削除・統合・修復はしない —— 何をどう直すかは業務判断で、
 * 自動でやってよいものではない。
 */

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

/**
 * 監視対象のテーブル名。backend.ts が `addEnvironment` で渡す。
 *
 * 環境変数が1つでも欠けていると、そのモデルの走査だけが失敗し、
 * 「取得できなかった」として記録される（0件にはならない）。
 */
const TABLE_ENV: Record<string, string> = INTEGRITY_TABLE_ENV;

function tableFor(model: string): string {
  const envKey = TABLE_ENV[model];
  const name = envKey ? process.env[envKey] : undefined;
  if (!name) throw new Error(`テーブル名が設定されていません (${model})`);
  return name;
}

export const handler = async (_event: unknown, context?: { awsRequestId?: string }) => {
  const logTable = process.env.INTEGRITY_LOG_TABLE_NAME;
  if (!logTable) {
    // 記録先が無いと差分判定そのものが成立しない。黙って成功にしない。
    console.error("[integrity-monitor] INTEGRITY_LOG_TABLE_NAME が設定されていません。");
    throw new Error("INTEGRITY_LOG_TABLE_NAME が設定されていません。");
  }
  const store = { ddb, tableName: logTable };
  const runAt = new Date().toISOString();

  const { metrics } = await collectIntegrityMetrics({ ddb, tableFor });
  const baseline = await loadBaseline(store);
  const result = compareIntegrity(metrics, baseline, runAt);

  // 記録は判定より先。ここで落ちても「何が起きたか」は残す。
  await appendHistory(store, toHistoryEntry(result));
  await saveBaseline(store, result.nextBaseline);

  // CloudWatch Logs へ人が読める形で残す。秘密値は含まない（件数とIDのみ）。
  console.log(formatRunResult(result));

  // ── アラーム用のメトリクスを毎回出す ────────────────────────────
  //
  // EMF（Embedded Metric Format）。決まった形のJSONをログへ出すだけで
  // CloudWatchが `BELLO/Integrity / IntegrityAlert` として拾う。
  // AWS::Logs::MetricFilter を使わないのは、その作成にロググループの
  // 実在が要り、まだ一度も走っていないアプリでデプロイが落ちるため
  // （amplify/backend.ts の該当コメント参照）。
  //
  // **正常時も 0 を出す。** 出さないとデータ欠損になり、異常のあと
  // アラームが ALARM のまま張り付いて次の異常に気づけなくなる。
  console.log(
    JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [
          { Namespace: "BELLO/Integrity", Dimensions: [[]], Metrics: [{ Name: "IntegrityAlert", Unit: "Count" }] },
        ],
      },
      IntegrityAlert: result.shouldNotify ? 1 : 0,
      overall: result.overall,
    }),
  );

  if (result.shouldNotify) {
    // ── 異常だけを、決まった形で1行目に出す ────────────────────────
    //
    // この `[integrity-monitor] ALERT` をCloudWatch Logsのメトリクスフィルタが
    // 拾い、アラーム経由で通知へ渡す。通知の送信そのものはここでは行わない
    // （アプリ本体へ通知コードを足さない方針）。
    //
    // **PASS と WARNING はここへ来ない。** shouldNotify が真になるのは
    // FAIL（新しい異常が増えた）と ERROR（検査できなかった）だけで、
    // 基準値の減少（WARNING）は記録に残るだけで通知しない
    // （lib/integrity/compare.ts のコメント参照）。
    //
    // 中身は「異常だけ」。正常な項目を並べると、本当に見るべき行が埋もれる。
    const lines = [
      `[integrity-monitor] ALERT ${result.overall}`,
      `BELLO Data Integrity Alert`,
      `発生日時: ${runAt}`,
      `判定: ${result.overall}`,
      // どの実行かを後から辿れるようにする。履歴テーブルの id は "run#<runAt>"。
      `実行ID: ${context?.awsRequestId ?? "(不明)"}`,
      `履歴: ${logTable} / id=run#${runAt}`,
      "",
      result.notificationText ?? "",
    ];
    console.warn(lines.join("\n"));
  }

  return {
    overall: result.overall,
    runAt,
    failed: result.comparisons.filter((c) => c.verdict === "FAIL").map((c) => c.key),
    errored: result.comparisons.filter((c) => c.verdict === "ERROR").map((c) => c.key),
  };
};

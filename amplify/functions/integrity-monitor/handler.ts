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

export const handler = async () => {
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

  if (result.shouldNotify) {
    // 通知の送信自体はここでは行わない（§18: 既存のLINE通知基盤への接続が
    // 大きな改修になる場合は保存までに留める）。CloudWatch Logs に
    // 決まった形で出しておき、メトリクスフィルタ/アラームから拾えるようにする。
    console.warn(`[integrity-monitor] ALERT ${result.overall}\n${result.notificationText}`);
  }

  return {
    overall: result.overall,
    runAt,
    failed: result.comparisons.filter((c) => c.verdict === "FAIL").map((c) => c.key),
    errored: result.comparisons.filter((c) => c.verdict === "ERROR").map((c) => c.key),
  };
};

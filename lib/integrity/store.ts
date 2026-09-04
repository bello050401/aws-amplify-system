/**
 * 整合性監視の基準値と実行履歴の保存（2026-09-04 最終フェーズ Phase B）。
 *
 * ── なぜリポジトリ内のファイルではなくDynamoDBなのか ────────────
 *
 * 基準値は「手元での実行」と「日次の自動実行」の**両方が読み書きする**。
 * リポジトリ内のJSONに置くと、Lambdaからは更新できず、手元の値と
 * クラウドの値がすぐに食い違う。食い違った基準値で差分を見ても意味がない。
 * 保存先は1つにする。
 *
 * ── 何を保存するか ──────────────────────────────────────────────
 *
 *   id = "baseline"          … 現在の基準値（1行だけ、上書き）
 *   id = "run#<ISO日時>"      … 実行履歴（追記のみ、消さない）
 *
 * 履歴には各項目の前回値・現在値・差分・判定を入れる。後から
 * 「いつ増えたのか」を追えるようにするため。
 *
 * ── 書き換えるのは自分の記録だけ ────────────────────────────────
 *
 * このモジュールは監視ログのテーブルにしか書かない。在庫・会話・通知の
 * どのテーブルにも書き込まない（自動修復はしない）。
 */
import { GetCommand, PutCommand, ScanCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { IntegrityBaseline, IntegrityHistoryEntry } from "./compare";

export const BASELINE_ID = "baseline";
export const RUN_ID_PREFIX = "run#";

export interface IntegrityStoreDeps {
  ddb: DynamoDBDocumentClient;
  tableName: string;
}

/** 保存済みの基準値。無ければ null（初回として扱う）。 */
export async function loadBaseline(deps: IntegrityStoreDeps): Promise<IntegrityBaseline | null> {
  const res = await deps.ddb.send(new GetCommand({ TableName: deps.tableName, Key: { id: BASELINE_ID } }));
  const item = res.Item as { updatedAt?: string; values?: Record<string, number> } | undefined;
  if (!item || !item.values) return null;
  return { updatedAt: item.updatedAt ?? "", values: item.values };
}

export async function saveBaseline(deps: IntegrityStoreDeps, baseline: IntegrityBaseline): Promise<void> {
  await deps.ddb.send(
    new PutCommand({
      TableName: deps.tableName,
      Item: { id: BASELINE_ID, updatedAt: baseline.updatedAt, values: baseline.values },
    }),
  );
}

export async function appendHistory(deps: IntegrityStoreDeps, entry: IntegrityHistoryEntry): Promise<void> {
  await deps.ddb.send(
    new PutCommand({
      TableName: deps.tableName,
      Item: {
        id: `${RUN_ID_PREFIX}${entry.runAt}`,
        runAt: entry.runAt,
        overall: entry.overall,
        metrics: entry.metrics,
        // 履歴は増え続けるので、1年で自然に消えるようにしておく
        // （DynamoDBのTTL。消えて困るのは基準値のほうで、そちらには付けない）。
        expiresAt: Math.floor(Date.parse(entry.runAt) / 1000) + 365 * 24 * 60 * 60,
      },
    }),
  );
}

/** 直近の実行履歴を新しい順に。件数の確認・画面表示用。 */
export async function recentHistory(deps: IntegrityStoreDeps, limit = 30): Promise<IntegrityHistoryEntry[]> {
  // idが "run#<ISO>" なので、begins_with で前方一致すれば時刻順に並ぶ。
  // このテーブルはこの用途専用でパーティションキーが id しか無いため、
  // 履歴の一覧は Scan ではなく **id の前方一致** で取る…が、DynamoDBは
  // パーティションキーへの begins_with を許さない。件数が少ない
  // （1日1行、TTLで1年）ので、素直に Scan して並べ替える。
  const res = await deps.ddb.send(
    new ScanCommand({
      TableName: deps.tableName,
      FilterExpression: "begins_with(id, :p)",
      ExpressionAttributeValues: { ":p": RUN_ID_PREFIX },
    }),
  );
  const rows = (res.Items ?? []) as unknown as IntegrityHistoryEntry[];
  return rows.sort((a, b) => (a.runAt < b.runAt ? 1 : -1)).slice(0, limit);
}

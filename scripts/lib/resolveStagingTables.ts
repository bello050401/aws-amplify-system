import { DynamoDBClient, ListTablesCommand } from "@aws-sdk/client-dynamodb";

/**
 * スクリプトから実データを触るときの `CONVERSATION_TABLE_NAME` 解決。
 *
 * ── なぜ必要か ──────────────────────────────────────────────────
 *
 * lib/ 側(webhookStore / contextStore / directData)は
 * `CONVERSATION_TABLE_NAME` からテーブル名を組み立てる。Amplify Hosting
 * では環境変数として入っているが、**ローカルのスクリプト実行では入って
 * いない**。毎回シェルで指定させると、取り違えたときに気づけない
 * (アカウントには空の残骸テーブルが同居している)。
 *
 * ── 件数では選ばない ────────────────────────────────────────────
 *
 * テーブル名は `<Model>-<apiId>-<env>`。同じアカウントに apiId が2つあり、
 * `Inventory-` で始まるテーブルが2つヒットする。片方は空の残骸。
 * **必要なモデルが揃っている apiId** を選ぶのが確実な見分け方
 * (verify-inquiry-live-case.ts / verify-zaico-reconciliation.ts と同じ方法)。
 */
const REQUIRED_MODELS = ["Inventory", "Conversation", "Message", "Category"];

export async function ensureConversationTableName(region = process.env.AWS_REGION || "us-west-2"): Promise<string> {
  const existing = process.env.CONVERSATION_TABLE_NAME;
  if (existing) return existing;

  const client = new DynamoDBClient({ region });
  const names: string[] = [];
  let start: string | undefined;
  do {
    const res = await client.send(new ListTablesCommand({ ExclusiveStartTableName: start }));
    names.push(...(res.TableNames ?? []));
    start = res.LastEvaluatedTableName;
  } while (start);

  const byApiId = new Map<string, Set<string>>();
  for (const n of names) {
    const m = /^([A-Za-z0-9]+)-([a-z0-9]{20,})-/.exec(n);
    if (!m) continue;
    if (!byApiId.has(m[2])) byApiId.set(m[2], new Set());
    byApiId.get(m[2])!.add(m[1]);
  }
  const complete = [...byApiId.entries()]
    .filter(([, models]) => REQUIRED_MODELS.every((r) => models.has(r)))
    .map(([apiId]) => apiId);
  if (complete.length !== 1) {
    throw new Error(
      `Amplify Data APIを一意に決められませんでした(候補${complete.length}件)。CONVERSATION_TABLE_NAME を明示してください。`,
    );
  }
  const hits = names.filter((n) => n.startsWith(`Conversation-${complete[0]}-`));
  if (hits.length !== 1) throw new Error("Conversation のテーブルを一意に決められませんでした。");
  process.env.CONVERSATION_TABLE_NAME = hits[0];
  const messageHits = names.filter((n) => n.startsWith(`Message-${complete[0]}-`));
  if (messageHits.length === 1) process.env.MESSAGE_TABLE_NAME ??= messageHits[0];
  return hits[0];
}

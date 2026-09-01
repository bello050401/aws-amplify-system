/**
 * 既存Conversationの顧客名を、LINEのプロフィールAPIから埋め直す。
 *
 * ## なぜ必要か
 *
 * Stagingの実データでは、LINE会話4件すべてで externalCustomerId
 * (LINEのuserId)は保存済みなのに customerDisplayName が NULL だった。
 * 原因はプロフィールAPIを呼ぶコードが無かったことで、userId は残って
 * いるので**後から復元できる**。
 *
 * ## 安全性
 *
 * - 顧客名が取れなかった会話は**触らない**。「不明な顧客」という文字列を
 *   保存してしまうと、後で取得できるようになっても「取得済み」に見えて
 *   再取得されなくなる。
 * - customerDisplayName 以外のフィールドは一切変更しない。
 * - 既に名前がある会話は上書きしない(--force で明示したときのみ)。
 *
 * Run: AWS_PROFILE=Bello node scripts/with-server-only-stub.cjs scripts/backfill-line-customer-names.ts [--apply]
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { fetchLineProfile } from "@/lib/messaging/line/profile";
import { shouldRefreshDisplayName } from "@/lib/messaging/line/profile";

const TABLE = process.env.CONVERSATION_TABLE_NAME || "Conversation-j6up24p7lnczdmklzjdt3vrp4y-NONE";
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION || "us-west-2" }));
const APPLY = process.argv.includes("--apply");

async function main() {
  const rows: Record<string, unknown>[] = [];
  let key: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(new ScanCommand({ TableName: TABLE, ExclusiveStartKey: key }));
    rows.push(...((res.Items ?? []) as Record<string, unknown>[]));
    key = res.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (key);

  const line = rows.filter((r) => r.channel === "LINE" && typeof r.externalCustomerId === "string" && r.externalCustomerId);
  console.log(`会話 ${rows.length}件 / LINE かつ userId あり ${line.length}件 (apply=${APPLY})`);

  let updated = 0;
  let skipped = 0;
  const failures: Record<string, number> = {};

  for (const row of line) {
    const hasName = typeof row.customerDisplayName === "string" && String(row.customerDisplayName).trim().length > 0;
    const fetchedAt = (row.customerNameFetchedAt as string | null) ?? null;
    if (!shouldRefreshDisplayName(fetchedAt, hasName)) {
      skipped++;
      continue;
    }

    const result = await fetchLineProfile(String(row.externalCustomerId));
    if (!result.ok) {
      failures[result.reason] = (failures[result.reason] ?? 0) + 1;
      // 取れなかったことは記録するが、名前は作らない。
      if (APPLY) {
        await ddb.send(new UpdateCommand({
          TableName: TABLE,
          Key: { id: row.id },
          UpdateExpression: "SET customerNameSource = :s, customerNameFetchedAt = :t",
          ExpressionAttributeValues: { ":s": `LINE_PROFILE_FAILED:${result.reason}`, ":t": new Date().toISOString() },
        }));
      }
      console.log(`  - ${String(row.id).slice(0, 8)} 取得できず: ${result.reason}`);
      continue;
    }

    console.log(`  ✓ ${String(row.id).slice(0, 8)} 表示名を取得(${result.profile.displayName.length}文字)`);
    if (APPLY) {
      await ddb.send(new UpdateCommand({
        TableName: TABLE,
        Key: { id: row.id },
        UpdateExpression: "SET customerDisplayName = :n, customerNameSource = :s, customerNameFetchedAt = :t, updatedAt = :t",
        ExpressionAttributeValues: { ":n": result.profile.displayName, ":s": "LINE_PROFILE", ":t": new Date().toISOString() },
      }));
    }
    updated++;
  }

  console.log(JSON.stringify({ applied: APPLY, wouldUpdate: updated, skipped, failures }, null, 1));
}

main().catch((e) => { console.error(e); process.exit(1); });

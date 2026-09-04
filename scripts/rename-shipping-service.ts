/**
 * 家財配送サービスの呼称を「らくらく家財便」へ揃える(2026-09-04)。
 *
 *   AWS_PROFILE=Bello npm run rename:shipping-service -- [--apply]
 *
 * 既定は**確認のみ**(何も書かない)。`--apply` を付けたときだけ更新する。
 *
 * ── 何を変えるのか ──────────────────────────────────────────────
 *
 * `ShippingRate.service` に入っている旧称(「家財おまかせ便」、実測450行)を
 * 新しい呼称へ書き換える。この項目は**表示のためだけ**に持っている値で、
 * 検索・突き合わせ・キーには一度も使われていない(lib/shipping/service.ts
 * は行をそのまま持ち回るだけ)。だから値を変えても料金の引き当ては変わらない。
 *
 * ── なぜ表示側の変換で済ませないのか ────────────────────────────
 *
 * 画面だけ新しい名前にすると、DBとCSVエクスポートには旧称が残る。
 * 「画面では らくらく家財便 なのに、書き出したCSVは 家財おまかせ便」は
 * 呼称が2つある状態そのもので、直したことにならない。
 *
 * ── 料金には触れない ────────────────────────────────────────────
 *
 * 更新するのは `service` の1項目だけ。price/surcharge/rank/都道府県は
 * 読み取りもしない。万一この作業が中断しても、料金データは無傷。
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ensureConversationTableName } from "./lib/resolveStagingTables";
import { KAZAI_SERVICE_NAME, LEGACY_KAZAI_SERVICE_NAMES } from "@/lib/shipping/serviceName";

async function main() {
  const apply = process.argv.includes("--apply");
  const conversationTable = await ensureConversationTableName();
  // テーブル名は `<Model>-<apiId>-<env>`。Conversation から接尾辞を借りる
  // (lib/amplify/directData.ts と同じ規則)。
  const suffix = conversationTable.replace(/^Conversation-/, "");
  const table = `ShippingRate-${suffix}`;

  const region = process.env.AWS_REGION || "us-west-2";
  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));

  console.log(`[rename-shipping-service] 対象テーブル: ${table}`);
  console.log(`  旧称: ${LEGACY_KAZAI_SERVICE_NAMES.join(" / ")}`);
  console.log(`  新称: ${KAZAI_SERVICE_NAME}`);
  console.log(apply ? "  モード: 更新します(--apply)" : "  モード: 確認のみ(--apply を付けると更新します)");

  const rows: { id: string; service: string }[] = [];
  let key: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(
      new ScanCommand({ TableName: table, ExclusiveStartKey: key, ProjectionExpression: "id, #s", ExpressionAttributeNames: { "#s": "service" } }),
    );
    for (const item of res.Items ?? []) rows.push({ id: String(item.id), service: String(item.service ?? "") });
    key = res.LastEvaluatedKey;
  } while (key);

  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.service, (counts.get(r.service) ?? 0) + 1);
  console.log(`\n  全${rows.length}行の内訳:`);
  for (const [value, count] of counts) console.log(`    ${value || "(空)"} … ${count}行`);

  const legacy = new Set<string>(LEGACY_KAZAI_SERVICE_NAMES);
  const target = rows.filter((r) => legacy.has(r.service));
  console.log(`\n  書き換え対象: ${target.length}行`);
  if (target.length === 0 || !apply) {
    console.log(apply ? "  対象がありません。" : "  --apply を付けると更新します。");
    return;
  }

  let updated = 0;
  let failed = 0;
  for (const row of target) {
    try {
      await ddb.send(
        new UpdateCommand({
          TableName: table,
          Key: { id: row.id },
          // service だけを更新する。料金の項目は式に一切現れない。
          UpdateExpression: "SET #s = :new, updatedAt = :now",
          // 旧称のままの行だけを更新する。並行して誰かが直していたら何もしない。
          ConditionExpression: "#s = :old",
          ExpressionAttributeNames: { "#s": "service" },
          ExpressionAttributeValues: { ":new": KAZAI_SERVICE_NAME, ":old": row.service, ":now": new Date().toISOString() },
        }),
      );
      updated++;
    } catch (err) {
      const name = err instanceof Error ? err.name : "";
      if (name === "ConditionalCheckFailedException") {
        // 既に別経路で更新済み。失敗として数えない。
        continue;
      }
      failed++;
      console.error(`  ! ${row.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  console.log(`\n  更新: ${updated}行 / 失敗: ${failed}行`);
}

void main().catch((err) => {
  console.error(`[rename-shipping-service] 失敗: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
